// Règles pures du tableau « mes runs des 7 derniers jours » (sans I/O).
// Lit le payload brut Strava stocké par la synchro et n'en garde que les champs affichés.

import { RETENTION_DAYS } from "../sync/rules";

const WINDOW_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type RecentRun = {
  id: number;
  name: string;
  startDate: string; // ISO 8601, tel que renvoyé par Strava (start_date, UTC)
  distanceM: number;
  movingTimeS: number;
  paceSPerKm: number | null; // null si la distance est nulle
  averageHeartrate: number | null;
};

export type RecentRuns = {
  runs: RecentRun[];
  total: { count: number; distanceM: number; movingTimeS: number };
};

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function paceSecondsPerKm(
  distanceM: number,
  movingTimeS: number,
): number | null {
  if (distanceM <= 0) return null;
  return movingTimeS / (distanceM / 1000);
}

// Renvoie null pour un payload illisible ou sans les champs indispensables.
export function parseRun(payload: string): RecentRun | null {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { id, name, start_date, distance, moving_time, average_heartrate } =
    data as Record<string, unknown>;
  if (!Number.isSafeInteger(id) || typeof start_date !== "string") return null;
  if (Number.isNaN(Date.parse(start_date))) return null;
  if (!isNonNegative(distance) || !isNonNegative(moving_time)) return null;
  return {
    id: id as number,
    name: typeof name === "string" ? name : "",
    startDate: start_date,
    distanceM: distance,
    movingTimeS: moving_time,
    paceSPerKm: paceSecondsPerKm(distance, moving_time),
    averageHeartrate:
      isNonNegative(average_heartrate) && average_heartrate > 0
        ? average_heartrate
        : null,
  };
}

// Courses parties dans les 7 derniers jours, de la plus récente à la plus ancienne (à départ
// identique, id décroissant pour un ordre stable), et leurs totaux.
export function summarizeRecentRuns(
  payloads: string[],
  nowMs: number,
): RecentRuns {
  const windowStart = nowMs - WINDOW_MS;
  const runs = payloads
    .map(parseRun)
    .filter((run): run is RecentRun => run !== null)
    .filter((run) => Date.parse(run.startDate) >= windowStart)
    .sort(
      (a, b) =>
        Date.parse(b.startDate) - Date.parse(a.startDate) || b.id - a.id,
    );
  return {
    runs,
    total: {
      count: runs.length,
      distanceM: runs.reduce((sum, run) => sum + run.distanceM, 0),
      movingTimeS: runs.reduce((sum, run) => sum + run.movingTimeS, 0),
    },
  };
}
