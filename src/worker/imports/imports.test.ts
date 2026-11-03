import { applyD1Migrations, env } from "cloudflare:test";
import { generateSignedCookie } from "hono/cookie";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  encodeFit,
  fitTime,
  type FitMessageSpec,
} from "../../core/fit.test-helpers";
import suuntoRunDataUrl from "../../core/fixtures/fit/suunto-run-anonymized.fit?inline";
import type { Bindings } from "../env";
import { app } from "../index";
import { generateToken, tokenSha256 } from "../personal-token/token";
import { resetDatabase } from "../test-db";
import { MAX_FIT_BYTES } from "./messages";
import type { FitImportResponse } from "./types";

const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };
const URL = "https://coach.example/api/imports/fit";
const SUUNTO_RUN = Uint8Array.from(
  atob(suuntoRunDataUrl.slice(suuntoRunDataUrl.indexOf(",") + 1)),
  (char) => char.charCodeAt(0),
);
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

// FIT synthétique : file_id Suunto + une session (sport FIT, distance en cm).
function syntheticFit(sport = 1, distanceCm = 1_020_050): Uint8Array {
  const start = fitTime(START);
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
        { num: 5, type: "enum", value: sport },
        { num: 7, type: "uint32", value: 3_200_400 },
        { num: 8, type: "uint32", value: 3_130_600 },
        { num: 9, type: "uint32", value: distanceCm },
        { num: 16, type: "uint8", value: 0 }, // FC à 0 : absence de mesure
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

function send(
  body: BodyInit | null,
  headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/octet-stream",
  },
) {
  return app.request(URL, { method: "POST", body, headers }, testEnv);
}

async function sendJson(
  body: BodyInit | null,
  headers?: Record<string, string>,
) {
  const response = await send(body, headers);
  return {
    http: response.status,
    body: (await response.json()) as FitImportResponse,
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
    `SELECT id, user_id, fit_sha256, start_date, sport_type, device, distance_m, moving_time_s,
      elapsed_time_s, elevation_gain_m, average_heartrate, max_heartrate
     FROM watch_activities ORDER BY id`,
  ).all<Record<string, unknown>>();
  return results;
}

async function journal() {
  const { results } = await env.DB.prepare(
    "SELECT user_id, status, activity_id FROM watch_imports ORDER BY id",
  ).all<{ user_id: number; status: string; activity_id: number | null }>();
  return results;
}

function fileForm(...files: [string, Uint8Array][]) {
  const form = new FormData();
  for (const [field, bytes] of files) {
    form.append(field, new File([bytes], "seance.fit"));
  }
  return form;
}

describe("POST /api/imports/fit — imported", () => {
  it("imports the real Suunto FIT sent by the Shortcut, R2 first then D1", async () => {
    const { http, body } = await sendJson(SUUNTO_RUN);

    expect(http).toBe(200);
    expect(body).toEqual({
      status: "imported",
      message: "Séance du 23 oct. 2026 importée : 13,1 km en 1:44:05",
      activity: {
        startDate: "2026-10-23T10:05:58Z",
        sportType: "Run",
        distanceM: 13106,
        movingTimeS: 6245,
      },
    });
    const sha = await sha256Hex(SUUNTO_RUN);
    expect(await activities()).toEqual([
      {
        id: 1,
        user_id: 1,
        fit_sha256: sha,
        start_date: "2026-10-23T10:05:58Z",
        sport_type: "Run",
        device: "suunto",
        distance_m: 13106,
        moving_time_s: 6245,
        elapsed_time_s: 6253,
        elevation_gain_m: 141,
        average_heartrate: 169,
        max_heartrate: 186,
      },
    ]);
    expect(await journal()).toEqual([
      { user_id: 1, status: "imported", activity_id: 1 },
    ]);
    const object = await env.FIT_BUCKET.get(`fit/1/${sha}.fit`);
    expect(new Uint8Array((await object?.arrayBuffer()) ?? [])).toEqual(
      SUUNTO_RUN,
    );
  });

  it("accepts a multipart upload with the session cookie (Import tab button)", async () => {
    const { http, body } = await sendJson(fileForm(["file", SUUNTO_RUN]), {
      Cookie: await sessionCookie(2),
    });

    expect(http).toBe(200);
    expect(body.status).toBe("imported");
    expect((await activities())[0]).toMatchObject({ user_id: 2 });
  });

  it.each([
    ["no content type", undefined],
    ["application/vnd.ant.fit", "application/vnd.ant.fit"],
  ])("accepts a raw body with %s", async (_label, contentType) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (contentType) headers["Content-Type"] = contentType;
    const body = new Blob([SUUNTO_RUN]).stream();

    expect((await sendJson(body, headers)).body.status).toBe("imported");
  });

  it("stores sessions that are not runs, with their Strava sport type", async () => {
    const { body } = await sendJson(syntheticFit(2));

    expect(body.activity?.sportType).toBe("Ride");
    expect(body.message).toBe(
      "Séance du 3 nov. 2026 importée : 10,2 km en 52:11",
    );
    expect(await activities()).toMatchObject([
      { sport_type: "Ride", average_heartrate: null },
    ]);
  });

  it("replaces the session when a new export of the same start arrives", async () => {
    await sendJson(syntheticFit(1, 1_000_000));
    const second = syntheticFit(1, 1_050_000);

    const { body } = await sendJson(second);

    expect(body.status).toBe("imported");
    const stored = await activities();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      distance_m: 10500,
      fit_sha256: await sha256Hex(second),
    });
    expect(await journal()).toEqual([
      { user_id: 1, status: "imported", activity_id: stored[0].id },
      { user_id: 1, status: "imported", activity_id: stored[0].id },
    ]);
  });
});

describe("POST /api/imports/fit — duplicate", () => {
  it("answers 200 duplicate for a file already imported, without writing it again", async () => {
    await sendJson(SUUNTO_RUN);

    const { http, body } = await sendJson(SUUNTO_RUN);

    expect(http).toBe(200);
    expect(body.status).toBe("duplicate");
    expect(body.message).toBe(
      "Séance du 23 oct. 2026 déjà importée : rien n'a changé.",
    );
    expect(await activities()).toHaveLength(1);
    expect(await journal()).toEqual([
      { user_id: 1, status: "imported", activity_id: 1 },
      { user_id: 1, status: "duplicate", activity_id: 1 },
    ]);
  });

  it("does not treat another user's identical file as a duplicate", async () => {
    await sendJson(SUUNTO_RUN);
    const { body } = await sendJson(fileForm(["file", SUUNTO_RUN]), {
      Cookie: await sessionCookie(2),
    });
    expect(body.status).toBe("imported");
  });
});

describe("POST /api/imports/fit — refused files", () => {
  it("answers 400 not_fit for a file without the FIT signature", async () => {
    const bytes = new TextEncoder().encode("<gpx>pas un FIT</gpx>");

    const { http, body } = await sendJson(bytes);

    expect(http).toBe(400);
    expect(body).toEqual({
      status: "not_fit",
      message:
        "Ce fichier n'est pas un fichier FIT. Dans l'app Suunto, exporte la séance au format FIT.",
    });
    expect(await journal()).toEqual([
      { user_id: 1, status: "not_fit", activity_id: null },
    ]);
    expect(
      await env.FIT_BUCKET.head(`fit/1/${await sha256Hex(bytes)}.fit`),
    ).toBeNull();
  });

  it.each([
    ["a wrong CRC", () => SUUNTO_RUN.map((b, i) => (i === 5000 ? b ^ 1 : b))],
    ["a truncated file", () => SUUNTO_RUN.slice(0, 1000)],
    ["no session (decoder no_session)", () => encodeFit([])],
  ])("answers 400 invalid for %s", async (_label, bytes) => {
    const { http, body } = await sendJson(bytes());

    expect(http).toBe(400);
    expect(body.status).toBe("invalid");
    expect(body.message).toMatch(/^Fichier FIT illisible/);
    expect(await activities()).toEqual([]);
    expect(await journal()).toEqual([
      { user_id: 1, status: "invalid", activity_id: null },
    ]);
  });

  it.each([
    ["two files", fileForm(["file", SUUNTO_RUN], ["file", SUUNTO_RUN])],
    ["a file in another field", fileForm(["fit", SUUNTO_RUN])],
    ["no file", new FormData()],
  ])("answers 400 invalid for a multipart body with %s", async (_l, form) => {
    const { http, body } = await sendJson(form, {
      Authorization: `Bearer ${token}`,
    });
    expect(http).toBe(400);
    expect(body.status).toBe("invalid");
    expect(body.message).toContain("un seul fichier FIT");
  });
});

describe("POST /api/imports/fit — quota", () => {
  async function logImports(count: number, status: string, receivedAt: string) {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO watch_imports (user_id, status, received_at)
       SELECT 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) FROM n`,
    )
      .bind(count, status, receivedAt)
      .run();
  }

  it("answers 429 quota after 30 imports in 24 h and logs the refusal", async () => {
    await logImports(30, "invalid", "-1 hour");

    const { http, body } = await sendJson(SUUNTO_RUN);

    expect(http).toBe(429);
    expect(body).toEqual({
      status: "quota",
      message: "Limite de 30 envois en 24 h atteinte. Réessaie plus tard.",
    });
    expect(await activities()).toEqual([]);
    expect((await journal()).at(-1)).toEqual({
      user_id: 1,
      status: "quota",
      activity_id: null,
    });
  });

  it("ignores imports older than 24 h, refusals for quota and other users", async () => {
    await logImports(29, "imported", "-1 hour");
    await logImports(10, "imported", "-25 hours");
    await logImports(10, "quota", "-1 hour");
    await env.DB.prepare(
      "INSERT INTO watch_imports (user_id, status) VALUES (2, 'imported')",
    ).run();

    expect((await sendJson(SUUNTO_RUN)).body.status).toBe("imported");
    expect((await sendJson(SUUNTO_RUN)).http).toBe(429);
  });
});

describe("POST /api/imports/fit — authentication", () => {
  it.each([
    ["an unknown token", { Authorization: `Bearer ${generateToken()}` }],
    ["a token in another scheme", { Authorization: "Basic abc" }],
  ])("answers 401 with %s, and logs nothing", async (_label, headers) => {
    const { http, body } = await sendJson(SUUNTO_RUN, {
      "Content-Type": "application/octet-stream",
      ...headers,
    });

    expect(http).toBe(401);
    expect(body.status).toBe("unauthorized");
    expect(body.message).toMatch(/jeton absent ou invalide/);
    expect(await journal()).toEqual([]);
  });

  it("tells the Import tab its session has expired when no token is sent", async () => {
    const { http, body } = await sendJson(SUUNTO_RUN, {
      "Content-Type": "application/octet-stream",
    });

    expect(http).toBe(401);
    expect(body).toEqual({
      status: "unauthorized",
      message:
        "Session expirée : reconnecte-toi à Running Coach, puis réessaie.",
    });
    expect(await journal()).toEqual([]);
  });

  it("refuses the token passed in the URL", async () => {
    const response = await app.request(
      `${URL}?token=${token}`,
      { method: "POST", body: SUUNTO_RUN },
      testEnv,
    );
    expect(response.status).toBe(401);
  });

  it("answers 401 for the session of a deleted user", async () => {
    const cookie = await sessionCookie(2);
    await env.DB.prepare("DELETE FROM users WHERE id = 2").run();

    const { http, body } = await sendJson(SUUNTO_RUN, { Cookie: cookie });

    expect(http).toBe(401);
    expect(body.message).toMatch(/^Session expirée/);
    expect(await activities()).toEqual([]);
  });

  it("does not open the rest of the API to the token", async () => {
    const response = await app.request(
      "https://coach.example/api/history/import",
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    );
    expect(response.status).toBe(401);
  });
});

describe("POST /api/imports/fit — size and content type", () => {
  it("answers 413 from Content-Length, before reading", async () => {
    const { http, body } = await sendJson(SUUNTO_RUN, {
      Authorization: `Bearer ${token}`,
      "Content-Length": String(MAX_FIT_BYTES + 1),
    });

    expect(http).toBe(413);
    expect(body.status).toBe("too_large");
    expect(body.message).toBe(
      "Fichier trop gros : 1,5 Mo au maximum pour une séance.",
    );
    expect(await journal()).toEqual([]);
  });

  it("answers 413 after reading a body without Content-Length", async () => {
    const big = new Uint8Array(MAX_FIT_BYTES + 1);
    const { http } = await sendJson(new Blob([big]).stream(), {
      Authorization: `Bearer ${token}`,
    });
    expect(http).toBe(413);
  });

  it("answers 413 for a multipart file just over the limit", async () => {
    const big = new Uint8Array(MAX_FIT_BYTES + 1);
    const { http } = await sendJson(fileForm(["file", big]), {
      Authorization: `Bearer ${token}`,
    });
    expect(http).toBe(413);
  });

  it("accepts a file of exactly 1.5 MiB (then reads it)", async () => {
    const { http, body } = await sendJson(new Uint8Array(MAX_FIT_BYTES));
    expect(http).toBe(400);
    expect(body.status).toBe("not_fit");
  });

  it.each(["text/plain", "application/json", "application/gpx+xml"])(
    "answers 415 for %s",
    async (contentType) => {
      const { http, body } = await sendJson(SUUNTO_RUN, {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
      });

      expect(http).toBe(415);
      expect(body.status).toBe("unsupported_type");
      expect(body.message).toMatch(/^Format d'envoi refusé/);
    },
  );
});
