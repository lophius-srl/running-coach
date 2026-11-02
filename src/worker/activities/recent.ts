// Règles pures du tableau « mes runs des 7 derniers jours » (sans I/O).
// Lit le payload brut Strava stocké par la synchro et n'en garde que les champs affichés.

import { elevationPerKm } from "../../core/elevation";
import { RETENTION_DAYS } from "../sync/rules";

const WINDOW_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type RecentRun = {
  id: number;
  name: string;
  startDate: string; // ISO 8601, tel que renvoyé par Strava (start_date, UTC)
  distanceM: number;
  movingTimeS: number;
  paceSPerKm: number | null; // null si la distance ou le temps est nul
  averageHeartrate: number | null;
  elevationGainM: number | null; // total_elevation_gain Strava ; null si absent
  elevationPerKm: number | null; // m de D+ par km, entier ; null si D+ absent ou distance nulle
};

type ElevationTotal = {
  elevationGainM: number | null; // null si aucun run n'a de D+
  elevationPerKm: number | null; // D+ total / distance des runs dont le D+ est connu
};

export type RecentRuns = {
  runs: RecentRun[];
  total: {
    count: number;
    distanceM: number;
    movingTimeS: number;
  } & ElevationTotal;
};

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function paceSecondsPerKm(
  distanceM: number,
  movingTimeS: number,
): number | null {
  if (distanceM <= 0 || movingTimeS <= 0) return null;
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
  const {
    id,
    name,
    start_date,
    distance,
    moving_time,
    average_heartrate,
    total_elevation_gain,
  } = data as Record<string, unknown>;
  if (!Number.isSafeInteger(id) || typeof start_date !== "string") return null;
  if (Number.isNaN(Date.parse(start_date))) return null;
  if (!isNonNegative(distance) || !isNonNegative(moving_time)) return null;
  const elevationGainM = isNonNegative(total_elevation_gain)
    ? total_elevation_gain
    : null;
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
    elevationGainM,
    elevationPerKm: elevationPerKm(elevationGainM, distance),
  };
}

// Un run sans D+ ne compte pas dans la distance du ratio, pour ne pas le tirer vers le bas.
function elevationTotal(runs: RecentRun[]): ElevationTotal {
  const withGain = runs.filter((run) => run.elevationGainM !== null);
  if (withGain.length === 0)
    return { elevationGainM: null, elevationPerKm: null };
  const gainM = withGain.reduce(
    (sum, run) => sum + (run.elevationGainM ?? 0),
    0,
  );
  const distanceM = withGain.reduce((sum, run) => sum + run.distanceM, 0);
  return {
    elevationGainM: gainM,
    elevationPerKm: elevationPerKm(gainM, distanceM),
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
    .filter((run) => {
      const startMs = Date.parse(run.startDate);
      return startMs >= windowStart && startMs <= nowMs;
    })
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
      ...elevationTotal(runs),
    },
  };
}
