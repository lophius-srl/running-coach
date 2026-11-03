// POST /api/imports/fit (issue #68, ADR 0005) : une séance de la montre, envoyée par le Raccourci
// iOS (jeton personnel) ou par le bouton de l'onglet Import (session). Le FIT brut part dans R2,
// son résumé dans watch_activities ; chaque envoi authentifié est journalisé dans watch_imports.
// Données de l'utilisateur, durables : jamais purgées par le cron, jamais envoyées à un LLM.
// Aucun log : ni jeton, ni mesure, ni exception brute.

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { decodeFitSummary, type FitSummary } from "../../core/fit";
import { readSession } from "../auth/session";
import type { AppEnv } from "../env";
import { userIdForBearer } from "../personal-token/verify";
import { isAcceptedContentType, maxBodyBytes, readFitBody } from "./body";
import {
  DAILY_IMPORT_QUOTA,
  FIXED_MESSAGES,
  SESSION_EXPIRED_MESSAGE,
  SINGLE_FILE_MESSAGE,
  duplicateMessage,
  importedMessage,
} from "./messages";
import type {
  FitImportResponse,
  ImportedActivity,
  LoggedImportStatus,
  RecentImportsResponse,
} from "./types";

const COUNT_RECENT_IMPORTS = `
  SELECT COUNT(*) AS n FROM watch_imports
  WHERE user_id = ? AND status != 'quota'
    AND received_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`;

const FIND_BY_SHA = `
  SELECT id, start_date, sport_type, distance_m, moving_time_s FROM watch_activities
  WHERE user_id = ? AND fit_sha256 = ?`;

// Ré-exportation de la même séance (même départ, autres octets) : la séance est remplacée.
const UPSERT_ACTIVITY = `
  INSERT INTO watch_activities (user_id, fit_sha256, start_date, sport_type, device, distance_m,
    moving_time_s, elapsed_time_s, elevation_gain_m, average_heartrate, max_heartrate)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, start_date) DO UPDATE SET
    fit_sha256 = excluded.fit_sha256,
    sport_type = excluded.sport_type,
    device = excluded.device,
    distance_m = excluded.distance_m,
    moving_time_s = excluded.moving_time_s,
    elapsed_time_s = excluded.elapsed_time_s,
    elevation_gain_m = excluded.elevation_gain_m,
    average_heartrate = excluded.average_heartrate,
    max_heartrate = excluded.max_heartrate,
    imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

const LOG_IMPORTED = `
  INSERT INTO watch_imports (user_id, status, activity_id)
  SELECT user_id, 'imported', id FROM watch_activities WHERE user_id = ? AND fit_sha256 = ?`;

const LOG_IMPORT =
  "INSERT INTO watch_imports (user_id, status, activity_id) VALUES (?, ?, ?)";

export const RECENT_IMPORTS_LIMIT = 20;

const RECENT_IMPORTS = `
  SELECT i.id, i.received_at AS receivedAt, i.status, a.start_date AS startDate,
    a.sport_type AS sportType, a.distance_m AS distanceM, a.moving_time_s AS movingTimeS
  FROM watch_imports i
  LEFT JOIN watch_activities a ON a.id = i.activity_id AND a.user_id = i.user_id
  WHERE i.user_id = ? ORDER BY i.received_at DESC, i.id DESC LIMIT ${RECENT_IMPORTS_LIMIT}`;

type RecentImportRow = {
  id: number;
  receivedAt: string;
  status: LoggedImportStatus;
} & { [K in keyof ImportedActivity]: ImportedActivity[K] | null };

type StoredActivity = {
  id: number;
  start_date: string;
  sport_type: string;
  distance_m: number;
  moving_time_s: number;
};

type ImportContext = Context<AppEnv>;

function reply(
  c: ImportContext,
  httpStatus: ContentfulStatusCode,
  body: FitImportResponse,
) {
  c.header("Cache-Control", "no-store");
  return c.json(body, httpStatus);
}

function fixed(
  c: ImportContext,
  status: keyof typeof FIXED_MESSAGES,
  httpStatus: ContentfulStatusCode,
) {
  return reply(c, httpStatus, { status, message: FIXED_MESSAGES[status] });
}

// Session (bouton de l'onglet Import) ou jeton personnel (Raccourci) : même userId.
async function authenticate(c: ImportContext): Promise<number | null> {
  const sessionUserId = await readSession(c, c.env.SESSION_SECRET);
  if (sessionUserId !== null) return sessionUserId;
  return userIdForBearer(c.env.DB, c.req.header("Authorization"));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function logImport(
  db: D1Database,
  userId: number,
  status: LoggedImportStatus,
  activityId: number | null = null,
) {
  return db.prepare(LOG_IMPORT).bind(userId, status, activityId).run();
}

function toActivity(summary: FitSummary): ImportedActivity {
  return {
    startDate: summary.startDate,
    sportType: summary.sportType,
    distanceM: summary.distanceM,
    movingTimeS: summary.movingTimeS,
  };
}

// Une FC à 0 est une absence de mesure (contrainte CHECK > 0).
const heartRate = (value: number | null) => (value === 0 ? null : value);

async function storeActivity(
  env: AppEnv["Bindings"],
  userId: number,
  sha: string,
  bytes: Uint8Array,
  summary: FitSummary,
) {
  // R2 d'abord : la clé est le hash, une écriture orpheline est réécrite à l'identique au renvoi.
  await env.FIT_BUCKET.put(`fit/${userId}/${sha}.fit`, bytes, {
    httpMetadata: { contentType: "application/vnd.ant.fit" },
  });
  const db = env.DB;
  await db.batch([
    db
      .prepare(UPSERT_ACTIVITY)
      .bind(
        userId,
        sha,
        summary.startDate,
        summary.sportType,
        summary.device,
        summary.distanceM,
        summary.movingTimeS,
        summary.elapsedTimeS,
        summary.elevationGainM,
        heartRate(summary.averageHeartrate),
        heartRate(summary.maxHeartrate),
      ),
    db.prepare(LOG_IMPORTED).bind(userId, sha),
  ]);
}

async function importFit(c: ImportContext, userId: number) {
  const db = c.env.DB;
  const quota = await db
    .prepare(COUNT_RECENT_IMPORTS)
    .bind(userId)
    .first<{ n: number }>();
  if ((quota?.n ?? 0) >= DAILY_IMPORT_QUOTA) {
    await logImport(db, userId, "quota");
    return fixed(c, "quota", 429);
  }

  const body = await readFitBody(c.req.raw);
  if (!body.ok) {
    if (body.reason === "too_large") return fixed(c, "too_large", 413);
    await logImport(db, userId, "invalid");
    return reply(c, 400, { status: "invalid", message: SINGLE_FILE_MESSAGE });
  }

  const sha = await sha256Hex(body.bytes);
  const existing = await db
    .prepare(FIND_BY_SHA)
    .bind(userId, sha)
    .first<StoredActivity>();
  if (existing) {
    await logImport(db, userId, "duplicate", existing.id);
    const activity: ImportedActivity = {
      startDate: existing.start_date,
      sportType: existing.sport_type,
      distanceM: existing.distance_m,
      movingTimeS: existing.moving_time_s,
    };
    return reply(c, 200, {
      status: "duplicate",
      message: duplicateMessage(activity),
      activity,
    });
  }

  const decoded = decodeFitSummary(body.bytes);
  if (!decoded.ok) {
    const status = decoded.error === "not_fit" ? "not_fit" : "invalid";
    await logImport(db, userId, status);
    return fixed(c, status, 400);
  }
  await storeActivity(c.env, userId, sha, body.bytes, decoded.summary);
  const activity = toActivity(decoded.summary);
  return reply(c, 200, {
    status: "imported",
    message: importedMessage(activity),
    activity,
  });
}

// Avec un en-tête Authorization, c'est le Raccourci (jeton) ; sinon, la session de l'onglet Import.
function unauthorized(c: ImportContext) {
  if (c.req.header("Authorization") !== undefined) {
    return fixed(c, "unauthorized", 401);
  }
  return reply(c, 401, {
    status: "unauthorized",
    message: SESSION_EXPIRED_MESSAGE,
  });
}

function isForeignKeyError(err: unknown): boolean {
  return err instanceof Error && /FOREIGN KEY/i.test(err.message);
}

export const fitImportRoutes = new Hono<AppEnv>();

// Chemin exempté du middleware de session (index.ts) : la route s'authentifie elle-même.
fitImportRoutes.post("/fit", async (c) => {
  const userId = await authenticate(c);
  if (userId === null) return unauthorized(c);
  const contentType = c.req.header("Content-Type");
  if (!isAcceptedContentType(contentType)) {
    return fixed(c, "unsupported_type", 415);
  }
  if (Number(c.req.header("Content-Length")) > maxBodyBytes(contentType)) {
    return fixed(c, "too_large", 413);
  }
  try {
    return await importFit(c, userId);
  } catch (err) {
    // Session encore valide d'un utilisateur supprimé : la clé étrangère refuse l'écriture.
    if (isForeignKeyError(err)) return unauthorized(c);
    // Exception réduite à un statut : rien du fichier ni de l'erreur ne part dans les logs.
    return fixed(c, "error", 500);
  }
});

// « Derniers imports » de l'onglet Import : session seulement. Le chemin est exempté du middleware
// (le POST accepte le jeton), donc la route vérifie elle-même la session et ignore tout Bearer.
fitImportRoutes.get("/fit", async (c) => {
  const userId = await readSession(c, c.env.SESSION_SECRET);
  if (userId === null) return c.json({ error: "unauthorized" }, 401);
  const { results } = await c.env.DB.prepare(RECENT_IMPORTS)
    .bind(userId)
    .all<RecentImportRow>();
  const body: RecentImportsResponse = {
    imports: results.map(({ id, receivedAt, status, ...activity }) => ({
      id,
      receivedAt,
      status,
      activity:
        activity.startDate === null ? null : (activity as ImportedActivity),
    })),
  };
  c.header("Cache-Control", "no-store");
  return c.json(body);
});
