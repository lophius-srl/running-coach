// Lecture des courses servant à estimer le niveau (#46) : historique importé (ADR 0004) et
// activités Strava API des 7 derniers jours fusionnés par id, puis séances de la montre (ADR 0005,
// src/core/watch-merge : mesures de la montre, nom et id de Strava). Le niveau est calculé à la volée par src/core/fitness,
// jamais stocké ni envoyé à un LLM (ADR 0003).

import {
  estimateFitness,
  FITNESS_WINDOW_DAYS,
  mergeRuns,
  type Fitness,
  type RunSample,
} from "../../core/fitness";
import { mergeWatchRuns } from "../../core/watch-merge";
import { WATCH_RUNS, type WatchRow } from "../imports/watch-runs";

const DAY_MS = 24 * 60 * 60 * 1000;

// Préfiltre SQL large d'un jour (formats ISO avec ou sans millisecondes) ; la borne exacte est
// appliquée par estimateFitness.
const IMPORTED_RUNS = `
  SELECT id, start_date AS startDate, sport_type AS sportType, distance_m AS distanceM,
    moving_time_s AS movingTimeS
  FROM imported_activities WHERE user_id = ? AND start_date >= ?`;

const API_PAYLOADS = "SELECT payload FROM strava_activities WHERE user_id = ?";

// Payload brut Strava → objet, ou null s'il est illisible.
export function parsePayload(payload: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(payload);
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Payload brut Strava → course ; null s'il est illisible ou incomplet.
export function stravaRunSample(payload: string): RunSample | null {
  const data = parsePayload(payload);
  return data === null ? null : runSampleOf(data);
}

export function runSampleOf(data: Record<string, unknown>): RunSample | null {
  const { id, start_date, sport_type, type, distance, moving_time } = data;
  const sportType = typeof sport_type === "string" ? sport_type : type;
  if (
    !Number.isSafeInteger(id) ||
    typeof start_date !== "string" ||
    Number.isNaN(Date.parse(start_date)) ||
    typeof sportType !== "string" ||
    typeof distance !== "number" ||
    typeof moving_time !== "number"
  ) {
    return null;
  }
  return {
    id: id as number,
    startDate: start_date,
    sportType,
    distanceM: distance,
    movingTimeS: moving_time,
  };
}

// Courses des 8 dernières semaines (+1 jour de marge), historique importé, API et montre fusionnés,
// avec les payloads Strava bruts et les séances montre (lus une seule fois pour « Ma semaine »).
export async function loadRunsAndPayloads(
  db: D1Database,
  userId: number,
  nowMs: number,
): Promise<{ runs: RunSample[]; payloads: string[]; watch: WatchRow[] }> {
  const since = new Date(
    nowMs - (FITNESS_WINDOW_DAYS + 1) * DAY_MS,
  ).toISOString();
  const [imported, api, watchRows] = await db.batch<unknown>([
    db.prepare(IMPORTED_RUNS).bind(userId, since),
    db.prepare(API_PAYLOADS).bind(userId),
    db.prepare(WATCH_RUNS).bind(userId, since),
  ]);
  const watch = watchRows.results as WatchRow[];
  const payloads = (api.results as { payload: string }[]).map(
    (row) => row.payload,
  );
  const apiRuns = payloads.map(stravaRunSample).filter((run) => run !== null);
  const stravaRuns = mergeRuns(imported.results as RunSample[], apiRuns);
  return { runs: mergeWatchRuns(stravaRuns, watch), payloads, watch };
}

export async function loadRuns(
  db: D1Database,
  userId: number,
  nowMs: number,
): Promise<RunSample[]> {
  return (await loadRunsAndPayloads(db, userId, nowMs)).runs;
}

export async function loadFitness(
  db: D1Database,
  userId: number,
  nowMs: number,
): Promise<Fitness | null> {
  return estimateFitness(await loadRuns(db, userId, nowMs), nowMs);
}
