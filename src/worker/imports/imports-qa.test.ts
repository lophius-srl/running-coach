// QA de l'issue #68 : cas limites de POST /api/imports/fit (sécurité, corps hostiles, données,
// quota, panne R2, isolation). Les cas nominaux sont dans imports.test.ts.
import { applyD1Migrations, env } from "cloudflare:test";
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
import {
  encodeFit,
  fitTime,
  type FitMessageSpec,
} from "../../core/fit.test-helpers";
import type { Bindings } from "../env";
import { app } from "../index";
import { generateToken, tokenSha256 } from "../personal-token/token";
import { resetDatabase } from "../test-db";
import { FIXED_MESSAGES, MAX_FIT_BYTES } from "./messages";
import type { FitImportResponse } from "./types";

const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };
const ORIGIN = "https://coach.example";
const URL = `${ORIGIN}/api/imports/fit`;
const START = "2026-11-03T07:30:00Z";

let token: string;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(() => resetDatabase(env.DB));
beforeEach(async () => {
  token = generateToken();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
    ),
    env.DB.prepare(
      "INSERT INTO personal_tokens (user_id, token_sha256) VALUES (1, ?)",
    ).bind(await tokenSha256(token)),
  ]);
});
afterEach(() => {
  vi.useRealTimers();
});

type SessionOptions = {
  sport?: number;
  distanceCm?: number;
  start?: string;
  avgHeartRate?: number;
  maxHeartRate?: number;
};

// FIT synthétique sans GPS : file_id Suunto + une session.
function syntheticFit(options: SessionOptions = {}): Uint8Array {
  const start = fitTime(options.start ?? START);
  const messages: FitMessageSpec[] = [
    {
      global: 0,
      fields: [
        { num: 0, type: "enum", value: 4 },
        { num: 1, type: "uint16", value: 23 },
        { num: 4, type: "uint32", value: start },
      ],
    },
    {
      global: 18,
      fields: [
        { num: 253, type: "uint32", value: start + 3130 },
        { num: 2, type: "uint32", value: start },
        { num: 5, type: "enum", value: options.sport ?? 1 },
        { num: 7, type: "uint32", value: 3_200_000 },
        { num: 8, type: "uint32", value: 3_130_000 },
        { num: 9, type: "uint32", value: options.distanceCm ?? 1_020_000 },
        { num: 16, type: "uint8", value: options.avgHeartRate ?? 150 },
        { num: 17, type: "uint8", value: options.maxHeartRate ?? 175 },
      ],
    },
  ];
  return encodeFit(messages);
}

async function sessionCookie(userId: number) {
  const signed = await generateSignedCookie(
    "session",
    `${userId}.9999999999`,
    testEnv.SESSION_SECRET,
    { prefix: "host", secure: true, path: "/" },
  );
  return signed.split(";")[0];
}

const bearer = () => ({ Authorization: `Bearer ${token}` });
const raw = () => ({
  ...bearer(),
  "Content-Type": "application/octet-stream",
});

async function send(
  body: BodyInit | null,
  headers: Record<string, string> = raw(),
  bindings: Bindings = testEnv,
) {
  const response = await app.request(
    URL,
    { method: "POST", body, headers },
    bindings,
  );
  return {
    http: response.status,
    text: await response.text(),
    get body() {
      return JSON.parse(this.text) as FitImportResponse;
    },
  };
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function activities() {
  const { results } = await env.DB.prepare(
    "SELECT * FROM watch_activities ORDER BY id",
  ).all<Record<string, unknown>>();
  return results;
}

async function journal() {
  const { results } = await env.DB.prepare(
    "SELECT user_id, status, activity_id FROM watch_imports ORDER BY id",
  ).all<{ user_id: number; status: string; activity_id: number | null }>();
  return results;
}

// Bucket R2 local, avec la liste des clés écrites par put.
function spiedBucket() {
  const puts: string[] = [];
  const bucket = new Proxy(env.FIT_BUCKET, {
    get(target, prop) {
      if (prop === "put") {
        return (...args: Parameters<R2Bucket["put"]>) => {
          puts.push(args[0]);
          return target.put(...args);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { puts, bindings: { ...testEnv, FIT_BUCKET: bucket } };
}

function form(entries: [string, string | File][]) {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

const fitFile = (bytes: Uint8Array, name = "seance.fit") =>
  new File([bytes], name);

describe("token scope", () => {
  it.each([
    ["GET", "/api/me"],
    ["GET", "/api/activities"],
    ["GET", "/api/goal"],
    ["PUT", "/api/goal"],
    ["GET", "/api/progression"],
    ["GET", "/api/plan"],
    ["POST", "/api/sync"],
    ["GET", "/api/personal-token"],
    ["POST", "/api/personal-token"],
    ["DELETE", "/api/personal-token"],
    ["POST", "/api/history/import"],
    ["GET", "/api/heart-rate-zones"],
  ])("answers 401 to a valid token on %s %s", async (method, path) => {
    const response = await app.request(
      `${ORIGIN}${path}`,
      { method, headers: bearer() },
      testEnv,
    );
    expect(response.status).toBe(401);
  });

  it("does not exempt /api/imports/fit/ (trailing slash) from the session", async () => {
    const response = await app.request(
      `${URL}/`,
      { method: "POST", body: syntheticFit(), headers: raw() },
      testEnv,
    );
    expect(response.status).toBe(401);
    expect(await journal()).toEqual([]);
  });

  it.each(["GET", "PUT", "PATCH", "DELETE"])(
    "exposes nothing on %s /api/imports/fit, with or without credentials",
    async (method) => {
      await send(syntheticFit());
      for (const headers of [{}, bearer()]) {
        const response = await app.request(URL, { method, headers }, testEnv);
        expect(response.status).toBe(404);
        const text = await response.text();
        expect(text).not.toMatch(/watch|startDate|distance|imported/i);
      }
      expect(await activities()).toHaveLength(1);
    },
  );
});

describe("token lifecycle", () => {
  it("refuses a token revoked from the Import tab", async () => {
    const revoke = await app.request(
      `${ORIGIN}/api/personal-token`,
      { method: "DELETE", headers: { Cookie: await sessionCookie(1) } },
      testEnv,
    );
    expect(revoke.ok).toBe(true);

    const { http, body } = await send(syntheticFit());

    expect(http).toBe(401);
    expect(body.status).toBe("unauthorized");
    expect(await journal()).toEqual([]);
  });

  it("refuses the token of a deleted user without writing anything", async () => {
    await env.DB.prepare("DELETE FROM users WHERE id = 1").run();
    const { puts, bindings } = spiedBucket();

    const { http } = await send(syntheticFit(), raw(), bindings);

    expect(http).toBe(401);
    expect(puts).toEqual([]);
    expect(await activities()).toEqual([]);
    expect(await journal()).toEqual([]);
  });

  it("gives priority to the session over another user's token", async () => {
    const { body } = await send(syntheticFit(), {
      ...raw(),
      Cookie: await sessionCookie(2),
    });

    expect(body.status).toBe("imported");
    expect(await activities()).toMatchObject([{ user_id: 2 }]);
    const tokenRow = await env.DB.prepare(
      "SELECT last_used_at FROM personal_tokens WHERE user_id = 1",
    ).first<{ last_used_at: string | null }>();
    expect(tokenRow?.last_used_at).toBeNull();
  });

  it("falls back to the token when the session cookie is forged", async () => {
    const { body } = await send(syntheticFit(), {
      ...raw(),
      Cookie: "__Host-session=2.9999999999.forged",
    });

    expect(body.status).toBe("imported");
    expect(await activities()).toMatchObject([{ user_id: 1 }]);
  });
});

describe("hostile bodies", () => {
  it("answers 400 not_fit for an empty raw body, and logs it", async () => {
    const { http, body } = await send(new Uint8Array(0));

    expect(http).toBe(400);
    expect(body.status).toBe("not_fit");
    expect(await journal()).toEqual([
      { user_id: 1, status: "not_fit", activity_id: null },
    ]);
  });

  it("answers 400 not_fit for a request without body nor content type", async () => {
    const { http, body } = await send(null, bearer());
    expect(http).toBe(400);
    expect(body.status).toBe("not_fit");
  });

  it("answers 413 when a small Content-Length hides a body over the limit", async () => {
    const big = new Uint8Array(MAX_FIT_BYTES + 1);
    const { http, body } = await send(new Blob([big]).stream(), {
      ...raw(),
      "Content-Length": "100",
    });

    expect(http).toBe(413);
    expect(body.status).toBe("too_large");
    expect(await activities()).toEqual([]);
  });

  it("answers 413 for a multipart stream over the limit without Content-Length", async () => {
    const request = new Request(URL, {
      method: "POST",
      body: form([
        ["file", fitFile(new Uint8Array(MAX_FIT_BYTES + 32 * 1024))],
      ]),
    });
    const response = await app.request(
      URL,
      {
        method: "POST",
        body: request.body,
        headers: {
          ...bearer(),
          "Content-Type": request.headers.get("Content-Type") ?? "",
        },
      },
      testEnv,
    );
    expect(response.status).toBe(413);
  });

  it("ignores a non-numeric Content-Length and reads the body", async () => {
    const { body } = await send(syntheticFit(), {
      ...raw(),
      "Content-Length": "beaucoup",
    });
    expect(body.status).toBe("imported");
  });

  it("answers 400 invalid for a multipart text field named file", async () => {
    const { http, body } = await send(
      form([["file", "pas un fichier"]]),
      bearer(),
    );

    expect(http).toBe(400);
    expect(body.status).toBe("invalid");
    expect(await journal()).toEqual([
      { user_id: 1, status: "invalid", activity_id: null },
    ]);
  });

  it("accepts a multipart file next to text fields", async () => {
    const { body } = await send(
      form([
        ["note", "texte"],
        ["file", fitFile(syntheticFit())],
      ]),
      bearer(),
    );
    expect(body.status).toBe("imported");
  });

  it("answers 400 invalid for a multipart body without boundary", async () => {
    const { http, body } = await send(syntheticFit(), {
      ...bearer(),
      "Content-Type": "multipart/form-data",
    });
    expect(http).toBe(400);
    expect(body.status).toBe("invalid");
  });

  it.each([
    "../../etc/passwd.fit",
    'a"; name="x.fit',
    "séance <script>alert(1)</script>.fit",
    `${"x".repeat(5000)}.fit`,
  ])("ignores the hostile file name %#", async (name) => {
    const bytes = syntheticFit();
    const { puts, bindings } = spiedBucket();

    const { body } = await send(
      form([["file", fitFile(bytes, name)]]),
      bearer(),
      bindings,
    );

    expect(body.status).toBe("imported");
    expect(puts).toEqual([`fit/1/${await sha256Hex(bytes)}.fit`]);
  });

  it.each([
    "Application/Octet-Stream",
    "application/octet-stream; charset=binary",
  ])("accepts the raw content type %s", async (contentType) => {
    const { body } = await send(syntheticFit(), {
      ...bearer(),
      "Content-Type": contentType,
    });
    expect(body.status).toBe("imported");
  });
});

describe("stored data", () => {
  it("stores a heart rate of 0 (average and max) as null", async () => {
    const { http, body } = await send(
      syntheticFit({ avgHeartRate: 0, maxHeartRate: 0 }),
    );
    expect(http).toBe(200);
    expect(body.status).toBe("imported");
    expect(await activities()).toMatchObject([
      { average_heartrate: null, max_heartrate: null },
    ]);
  });

  it("writes neither R2 nor the activity again for a duplicate, only the log", async () => {
    const bytes = syntheticFit();
    await send(bytes);
    const before = await activities();
    const { puts, bindings } = spiedBucket();

    const { body } = await send(bytes, raw(), bindings);

    expect(body.status).toBe("duplicate");
    expect(puts).toEqual([]);
    expect(await activities()).toEqual(before);
    expect((await journal()).map((row) => row.status)).toEqual([
      "imported",
      "duplicate",
    ]);
  });

  it("replaces a re-export: one row, new R2 object, log pointing at that row", async () => {
    await send(syntheticFit({ distanceCm: 1_000_000 }));
    const reExport = syntheticFit({ distanceCm: 1_010_000 });
    const { puts, bindings } = spiedBucket();

    const { body } = await send(reExport, raw(), bindings);

    const sha = await sha256Hex(reExport);
    expect(body.message).toBe(
      "Séance du 3 nov. 2026 importée : 10,1 km en 52:10",
    );
    expect(puts).toEqual([`fit/1/${sha}.fit`]);
    const rows = await activities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fit_sha256: sha, distance_m: 10100 });
    expect((await journal()).at(-1)).toEqual({
      user_id: 1,
      status: "imported",
      activity_id: rows[0].id,
    });
  });

  it("keeps two sessions with different starts as two rows", async () => {
    await send(syntheticFit());
    await send(syntheticFit({ start: "2026-11-04T07:30:00Z" }));
    expect(await activities()).toHaveLength(2);
  });

  it("keeps users apart: same file, two objects and two rows", async () => {
    const bytes = syntheticFit();
    const sha = await sha256Hex(bytes);
    await send(bytes);
    await send(bytes, {
      Cookie: await sessionCookie(2),
      "Content-Type": "application/octet-stream",
    });

    expect((await activities()).map((row) => row.user_id)).toEqual([1, 2]);
    expect(await env.FIT_BUCKET.head(`fit/1/${sha}.fit`)).not.toBeNull();
    expect(await env.FIT_BUCKET.head(`fit/2/${sha}.fit`)).not.toBeNull();
  });

  it("deletes the user's watch activities and log with the user", async () => {
    await send(syntheticFit());
    await env.DB.prepare("DELETE FROM users WHERE id = 1").run();
    expect(await activities()).toEqual([]);
    expect(await journal()).toEqual([]);
  });
});

describe("R2 failure", () => {
  it("answers 500 without D1 row and without leaking the error", async () => {
    const failing = new Proxy(env.FIT_BUCKET, {
      get(target, prop) {
        if (prop === "put") {
          return () =>
            Promise.reject(new Error("R2 secret-bucket-detail unavailable"));
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const { http, text, body } = await send(syntheticFit(), raw(), {
      ...testEnv,
      FIT_BUCKET: failing,
    });

    expect(http).toBe(500);
    expect(body).toEqual({ status: "error", message: FIXED_MESSAGES.error });
    expect(text).not.toContain("secret-bucket-detail");
    expect(await activities()).toEqual([]);
    expect(await journal()).toEqual([]);
  });
});

describe("quota window", () => {
  async function logImports(count: number, receivedAt: string, userId = 1) {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO watch_imports (user_id, status, received_at)
       SELECT ?, 'imported', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) FROM n`,
    )
      .bind(count, userId, receivedAt)
      .run();
  }

  it("counts an import received 23 h 59 ago", async () => {
    await logImports(30, "-1439 minutes");
    expect((await send(syntheticFit())).http).toBe(429);
  });

  it("no longer counts an import received 24 h 01 ago", async () => {
    await logImports(30, "-1441 minutes");
    expect((await send(syntheticFit())).body.status).toBe("imported");
  });

  it("accepts the 30th send and refuses the 31st without reading it", async () => {
    await logImports(29, "-1 hour");
    expect((await send(syntheticFit())).body.status).toBe("imported");
    const { puts, bindings } = spiedBucket();

    const refused = await send(
      syntheticFit({ start: "2026-11-05T07:30:00Z" }),
      raw(),
      bindings,
    );

    expect(refused.http).toBe(429);
    expect(puts).toEqual([]);
    expect(await activities()).toHaveLength(1);
  });

  it("does not let another user's quota block this user", async () => {
    await logImports(30, "-1 hour", 2);
    expect((await send(syntheticFit())).body.status).toBe("imported");
  });

  it("counts duplicates and refused files, but not 413, 415 nor 401", async () => {
    await logImports(28, "-1 hour");
    await send(new Uint8Array(MAX_FIT_BYTES + 1));
    await send(syntheticFit(), { ...bearer(), "Content-Type": "text/plain" });
    await send(syntheticFit(), { "Content-Type": "application/octet-stream" });
    await send(new TextEncoder().encode("pas un FIT"));

    expect((await send(syntheticFit())).body.status).toBe("imported");
    expect((await send(syntheticFit())).http).toBe(429);
  });
});

describe("existing computations", () => {
  const READ_ROUTES = [
    "/api/activities",
    "/api/goal",
    "/api/progression?period=all&group=week",
    "/api/plan",
  ];

  async function readAll(cookie: string) {
    const bodies: Record<string, string> = {};
    for (const path of READ_ROUTES) {
      const response = await app.request(
        `${ORIGIN}${path}`,
        { headers: { Cookie: cookie } },
        testEnv,
      );
      expect(response.status).toBe(200);
      bodies[path] = await response.text();
    }
    return bodies;
  }

  // Depuis #69, les courses de la montre sont fusionnées (src/core/watch-merge) ; le reste est ignoré.
  it("ignore non-run watch sessions but merges watch runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    await env.DB.prepare(
      `INSERT INTO goals (user_id, race_date, distance_m, target_time_s, available_days)
       VALUES (1, '2027-03-07', 21097, 6300, '[1,3,6]')`,
    ).run();
    const cookie = await sessionCookie(1);
    const before = await readAll(cookie);

    await send(
      syntheticFit({
        sport: 2,
        distanceCm: 4_321_000,
        start: "2026-11-03T15:00:00Z",
      }),
    );
    expect(await readAll(cookie)).toEqual(before);

    await send(syntheticFit({ sport: 1, distanceCm: 1_234_500 }));
    expect(await activities()).toHaveLength(2);
    const after = await readAll(cookie);
    const week = JSON.parse(after["/api/activities"]) as {
      runs: { id: number; name: string; distanceM: number }[];
    };
    expect(week.runs).toHaveLength(1);
    expect(week.runs[0]).toMatchObject({
      name: "Séance Suunto",
      distanceM: 12_345,
    });
    expect(week.runs[0].id).toBeLessThan(0);
  });
});
