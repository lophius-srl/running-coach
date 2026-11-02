// Progression (issue #61) : GET /api/progression?period=3m|6m|1y|all&group=week|month.
// Historique importé (ADR 0004) + activités API des 7 derniers jours, fusionnés par id (l'API
// l'emporte). Séries calculées à la lecture par src/core/progression.ts : jamais stockées,
// jamais envoyées à un LLM (ADR 0003).

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { APP_TIME_ZONE } from "../goals/rules";
import { parsePayload, runSampleOf } from "../goals/fitness";
import { FITNESS_WINDOW_DAYS, mergeRuns } from "../../core/fitness";
import {
  buildProgression,
  isGrouping,
  isHistoryStale,
  isPeriod,
  progressionStartMs,
  type ProgressionResponse,
  type ProgressionRun,
} from "../../core/progression";
import { RUN_TYPES } from "../../core/run-types";

const DAY_MS = 24 * 60 * 60 * 1000;

// Préfiltre large (niveau glissant : 8 semaines avant la première période, +1 jour de marge).
const IMPORTED_RUNS = `
  SELECT id, start_date AS startDate, sport_type AS sportType, distance_m AS distanceM,
    moving_time_s AS movingTimeS, elevation_gain_m AS elevationGainM,
    average_heartrate AS averageHeartrate
  FROM imported_activities WHERE user_id = ? AND start_date >= ?`;
const LAST_IMPORTED =
  "SELECT MAX(start_date) AS last FROM imported_activities WHERE user_id = ?";
const API_PAYLOADS = "SELECT payload FROM strava_activities WHERE user_id = ?";

function positiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

// Payload brut Strava → course avec D+ et FC ; null s'il est illisible ou incomplet.
export function stravaProgressionRun(payload: string): ProgressionRun | null {
  const data = parsePayload(payload);
  const sample = data === null ? null : runSampleOf(data);
  if (data === null || sample === null) return null;
  const heartrate = positiveOrNull(data.average_heartrate);
  return {
    ...sample,
    elevationGainM: positiveOrNull(data.total_elevation_gain),
    averageHeartrate: heartrate === 0 ? null : heartrate,
  };
}

function latest(dates: (string | null)[]): string | null {
  let best: string | null = null;
  for (const date of dates) {
    if (date !== null && (best === null || Date.parse(date) > Date.parse(best)))
      best = date;
  }
  return best;
}

export const progressionRoutes = new Hono<AppEnv>();

progressionRoutes.get("/", async (c) => {
  const period = c.req.query("period");
  const group = c.req.query("group");
  if (!isPeriod(period) || !isGrouping(group)) {
    return c.json({ error: "invalid_query" }, 400);
  }
  const nowMs = Date.now();
  const startMs = progressionStartMs(period, group, nowMs, APP_TIME_ZONE);
  const since =
    startMs === null
      ? ""
      : new Date(startMs - (FITNESS_WINDOW_DAYS + 1) * DAY_MS).toISOString();
  const db = c.env.DB;
  const userId = c.get("userId");
  const [imported, last, api] = await db.batch<unknown>([
    db.prepare(IMPORTED_RUNS).bind(userId, since),
    db.prepare(LAST_IMPORTED).bind(userId),
    db.prepare(API_PAYLOADS).bind(userId),
  ]);
  const apiRuns = (api.results as { payload: string }[])
    .map((row) => stravaProgressionRun(row.payload))
    .filter((run) => run !== null);
  const runs = mergeRuns(imported.results as ProgressionRun[], apiRuns);
  const lastImportedRunDate =
    (last.results[0] as { last: string | null } | undefined)?.last ?? null;
  const response: ProgressionResponse = {
    period,
    group,
    buckets: buildProgression(runs, period, group, nowMs, APP_TIME_ZONE),
    lastRunDate: latest([
      lastImportedRunDate,
      ...apiRuns
        .filter((run) => RUN_TYPES.has(run.sportType))
        .map((run) => run.startDate),
    ]),
    lastImportedRunDate,
    historyStale: isHistoryStale(lastImportedRunDate, nowMs),
  };
  return c.json(response);
});
