// Lecture des courses servant à estimer le niveau (#46) : historique importé (ADR 0004) et
// activités Strava API des 7 derniers jours. Le niveau est calculé à la volée par src/core/fitness,
// jamais stocké ni envoyé à un LLM (ADR 0003).

import {
  estimateFitness,
  FITNESS_WINDOW_DAYS,
  mergeRuns,
  type Fitness,
  type RunSample,
} from "../../core/fitness";

const DAY_MS = 24 * 60 * 60 * 1000;

// Préfiltre SQL large d'un jour (formats ISO avec ou sans millisecondes) ; la borne exacte est
// appliquée par estimateFitness.
const IMPORTED_RUNS = `
  SELECT id, start_date AS startDate, sport_type AS sportType, distance_m AS distanceM,
    moving_time_s AS movingTimeS
  FROM imported_activities WHERE user_id = ? AND start_date >= ?`;

const API_PAYLOADS = "SELECT payload FROM strava_activities WHERE user_id = ?";

// Payload brut Strava → course ; null s'il est illisible ou incomplet.
export function stravaRunSample(payload: string): RunSample | null {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { id, start_date, sport_type, type, distance, moving_time } =
    data as Record<string, unknown>;
  const sportType = typeof sport_type === "string" ? sport_type : type;
  if (
    !Number.isSafeInteger(id) ||
    typeof start_date !== "string" ||
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

export async function loadFitness(
  db: D1Database,
  userId: number,
  nowMs: number,
): Promise<Fitness | null> {
  const since = new Date(
    nowMs - (FITNESS_WINDOW_DAYS + 1) * DAY_MS,
  ).toISOString();
  const [imported, api] = await db.batch<RunSample | { payload: string }>([
    db.prepare(IMPORTED_RUNS).bind(userId, since),
    db.prepare(API_PAYLOADS).bind(userId),
  ]);
  const apiRuns = (api.results as { payload: string }[])
    .map((row) => stravaRunSample(row.payload))
    .filter((run) => run !== null);
  return estimateFitness(
    mergeRuns(imported.results as RunSample[], apiRuns),
    nowMs,
  );
}
