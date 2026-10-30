// Import de l'historique depuis l'export de compte Strava (ADR 0004) : le navigateur lit
// activities.csv et envoie les courses résumées par lots ; le Worker revalide puis stocke dans
// imported_activities (table durable, jamais purgée par le cron, jamais envoyée à un LLM).

import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
  IMPORT_BATCH_SIZE,
  validateImportedRun,
  type ImportedRun,
} from "../../core/history-csv";

// Un lot de 200 courses pèse ≈ 40 Ko ; au-delà, refus avant JSON.parse pour borner le CPU.
// Mesuré en caractères (≤ octets) : borne approximative mais sûre.
const MAX_BODY_LENGTH = 256 * 1024;

export type ImportResult = { inserted: number; alreadyPresent: number };

// D1 limite les requêtes par invocation (50 en offre gratuite) et les paramètres liés par requête
// (100) : le lot entier passe en un seul paramètre JSON, lu par json_each, au lieu d'un upsert par
// ligne. Comptage et upsert sont dans le même db.batch(), donc dans la même transaction.
const COUNT_EXISTING = `
  SELECT COUNT(*) AS n FROM imported_activities
  WHERE user_id = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`;

// « WHERE true » lève l'ambiguïté de SQLite entre INSERT … SELECT et la clause ON CONFLICT.
const UPSERT_RUNS = `
  INSERT INTO imported_activities (user_id, id, start_date, sport_type, name, distance_m,
    moving_time_s, elevation_gain_m, average_heartrate)
  SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.startDate'),
    json_extract(value, '$.sportType'), json_extract(value, '$.name'),
    json_extract(value, '$.distanceM'), json_extract(value, '$.movingTimeS'),
    json_extract(value, '$.elevationGainM'), json_extract(value, '$.averageHeartrate')
  FROM json_each(?) WHERE true
  ON CONFLICT (user_id, id) DO UPDATE SET
    start_date = excluded.start_date,
    sport_type = excluded.sport_type,
    name = excluded.name,
    distance_m = excluded.distance_m,
    moving_time_s = excluded.moving_time_s,
    elevation_gain_m = excluded.elevation_gain_m,
    average_heartrate = excluded.average_heartrate`;

function parseRows(text: string): unknown[] | null {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null) return null;
    const { rows } = body as { rows?: unknown };
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

// Une même course envoyée deux fois dans le lot : la dernière l'emporte, comme dans le fichier.
function uniqueById(runs: ImportedRun[]): ImportedRun[] {
  return [...new Map(runs.map((run) => [run.id, run])).values()];
}

function isForeignKeyError(err: unknown): boolean {
  return err instanceof Error && /FOREIGN KEY/i.test(err.message);
}

export const historyRoutes = new Hono<AppEnv>();

historyRoutes.post("/import", async (c) => {
  const tooLarge = { error: "too_large", maxRows: IMPORT_BATCH_SIZE };
  if (Number(c.req.header("Content-Length")) > MAX_BODY_LENGTH) {
    return c.json(tooLarge, 413);
  }
  const text = await c.req.text();
  if (text.length > MAX_BODY_LENGTH) return c.json(tooLarge, 413);

  const rows = parseRows(text);
  if (rows === null) return c.json({ error: "invalid_body" }, 400);
  if (rows.length > IMPORT_BATCH_SIZE) return c.json(tooLarge, 413);

  const nowMs = Date.now();
  const validated = rows.map((row) => validateImportedRun(row, nowMs));
  const invalidRows = validated.flatMap((run, i) => (run === null ? [i] : []));
  if (invalidRows.length > 0) {
    return c.json({ error: "invalid_rows", invalidRows }, 400);
  }

  const runs = uniqueById(validated.filter((run) => run !== null));
  if (runs.length === 0) return c.json({ inserted: 0, alreadyPresent: 0 });

  const db = c.env.DB;
  const userId = c.get("userId");
  const json = JSON.stringify(runs);
  let existing: D1Result<{ n: number }>;
  try {
    [existing] = await db.batch<{ n: number }>([
      db.prepare(COUNT_EXISTING).bind(userId, json),
      db.prepare(UPSERT_RUNS).bind(userId, json),
    ]);
  } catch (err) {
    // Session encore valide d'un utilisateur supprimé : la clé étrangère refuse l'écriture.
    if (isForeignKeyError(err)) return c.json({ error: "unauthorized" }, 401);
    throw err;
  }
  const alreadyPresent = existing.results[0]?.n ?? 0;
  const result: ImportResult = {
    inserted: runs.length - alreadyPresent,
    alreadyPresent,
  };
  return c.json(result);
});
