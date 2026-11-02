// Règles pures du tableau « mes runs des 7 derniers jours » (sans I/O).
// Lit le payload brut Strava stocké par la synchro et n'en garde que les champs affichés.

import { elevationPerKm } from "../../core/elevation";
import { runVdot } from "../../core/fitness";
import type { HeartRateZone } from "../../core/heart-rate";
import {
  heartRateZone,
  metersPerBeat,
  paceZone,
  weekShare,
  type PaceZone,
} from "../../core/run-insights";
import { RETENTION_DAYS } from "../sync/rules";

const WINDOW_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type RunSurface = "road" | "trail" | "treadmill";
export type RunWorkout = "race" | "long" | "intervals";

// Champs lus dans le payload Strava. Un champ absent, d'un autre type, négatif ou non fini → null.
export type ParsedRun = {
  id: number;
  name: string;
  startDate: string; // ISO 8601, tel que renvoyé par Strava (start_date, UTC)
  distanceM: number;
  movingTimeS: number;
  paceSPerKm: number | null; // null si la distance ou le temps est nul
  averageHeartrate: number | null;
  elevationGainM: number | null; // total_elevation_gain Strava ; null si absent
  elevationPerKm: number | null; // m de D+ par km, entier ; null si D+ absent ou distance nulle
  sportType: string; // sport_type (à défaut type) ; "" si absent
  surface: RunSurface; // tapis : trainer ou VirtualRun ; trail : TrailRun ; sinon route
  workout: RunWorkout | null; // workout_type 1, 2, 3
  elapsedTimeS: number | null;
  pauseS: number | null; // elapsed_time − moving_time, jamais négatif
  maxPaceSPerKm: number | null; // depuis max_speed (m/s)
  maxHeartrate: number | null;
  cadenceSpm: number | null; // pas/min : Strava donne des foulées/min (× 2), arrondi
  elevLowM: number | null; // altitudes : valeurs non finies ou min > max rejetées
  elevHighM: number | null;
  sufferScore: number | null;
  prCount: number | null;
  achievementCount: number | null;
  kudosCount: number | null;
};

// Indicateurs calculés à la volée (src/core/run-insights.ts), jamais stockés (ADR 0003).
export type RunInsights = {
  paceZone: PaceZone | null; // selon le niveau actuel ; null en trail (allure faussée par le D+)
  heartRateZone: number | null; // 1 à 5, si les zones cardiaques sont définies
  metersPerBeat: number | null;
  vdot: number | null; // si la sortie est exploitable (src/core/fitness.ts)
  weekShare: number | null; // part de la distance des 7 jours, 0 à 1
};

export type RecentRun = ParsedRun & RunInsights;

// Ce qu'il faut, en plus des payloads, pour situer chaque sortie.
export type RunContext = {
  vdot: number | null; // niveau actuel
  heartRateZones: readonly HeartRateZone[] | null;
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

const nonNegative = (value: unknown) => (isNonNegative(value) ? value : null);
const positive = (value: unknown) =>
  isNonNegative(value) && value > 0 ? value : null;
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;

const WORKOUTS = new Map<unknown, RunWorkout>([
  [1, "race"],
  [2, "long"],
  [3, "intervals"],
]);

function surface(sportType: string, trainer: unknown): RunSurface {
  if (trainer === true || sportType === "VirtualRun") return "treadmill";
  return sportType === "TrailRun" ? "trail" : "road";
}

// Altitudes min et max ; une paire incohérente (min au-dessus du max) est écartée.
function altitudeRange(elevLowM: number | null, elevHighM: number | null) {
  return elevLowM !== null && elevHighM !== null && elevLowM > elevHighM
    ? { elevLowM: null, elevHighM: null }
    : { elevLowM, elevHighM };
}

export function paceSecondsPerKm(
  distanceM: number,
  movingTimeS: number,
): number | null {
  if (distanceM <= 0 || movingTimeS <= 0) return null;
  return movingTimeS / (distanceM / 1000);
}

// Renvoie null pour un payload illisible ou sans les champs indispensables.
export function parseRun(payload: string): ParsedRun | null {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const raw = data as Record<string, unknown>;
  const { id, name, start_date, distance, moving_time } = raw;
  if (!Number.isSafeInteger(id) || typeof start_date !== "string") return null;
  if (Number.isNaN(Date.parse(start_date))) return null;
  if (!isNonNegative(distance) || !isNonNegative(moving_time)) return null;
  const sportType = [raw.sport_type, raw.type].find(
    (value) => typeof value === "string",
  ) as string | undefined;
  const elevationGainM = nonNegative(raw.total_elevation_gain);
  const elapsedTimeS = nonNegative(raw.elapsed_time);
  const maxSpeed = positive(raw.max_speed);
  const cadence = positive(raw.average_cadence);
  const altitudes = altitudeRange(finite(raw.elev_low), finite(raw.elev_high));
  return {
    id: id as number,
    name: typeof name === "string" ? name : "",
    startDate: start_date,
    sportType: sportType ?? "",
    surface: surface(sportType ?? "", raw.trainer),
    workout: WORKOUTS.get(raw.workout_type) ?? null,
    distanceM: distance,
    movingTimeS: moving_time,
    elapsedTimeS,
    pauseS:
      elapsedTimeS === null ? null : Math.max(0, elapsedTimeS - moving_time),
    paceSPerKm: paceSecondsPerKm(distance, moving_time),
    maxPaceSPerKm: maxSpeed === null ? null : 1000 / maxSpeed,
    averageHeartrate: positive(raw.average_heartrate),
    maxHeartrate: positive(raw.max_heartrate),
    cadenceSpm: cadence === null ? null : Math.round(cadence * 2),
    elevationGainM,
    elevationPerKm: elevationPerKm(elevationGainM, distance),
    ...altitudes,
    sufferScore: nonNegative(raw.suffer_score),
    prCount: count(raw.pr_count),
    achievementCount: count(raw.achievement_count),
    kudosCount: count(raw.kudos_count),
  };
}

function insights(
  run: ParsedRun,
  weekDistanceM: number,
  context: RunContext,
  nowMs: number,
): RunInsights {
  return {
    paceZone:
      run.surface === "trail" ? null : paceZone(run.paceSPerKm, context.vdot),
    heartRateZone: heartRateZone(run.averageHeartrate, context.heartRateZones),
    metersPerBeat: metersPerBeat(
      run.distanceM,
      run.movingTimeS,
      run.averageHeartrate,
    ),
    vdot: runVdot(run, nowMs),
    weekShare: weekShare(run.distanceM, weekDistanceM),
  };
}

// Un run sans D+ ne compte pas dans la distance du ratio, pour ne pas le tirer vers le bas.
function elevationTotal(runs: ParsedRun[]): ElevationTotal {
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
// identique, id décroissant pour un ordre stable), leurs indicateurs et leurs totaux.
export function summarizeRecentRuns(
  payloads: string[],
  nowMs: number,
  context: RunContext = { vdot: null, heartRateZones: null },
): RecentRuns {
  const windowStart = nowMs - WINDOW_MS;
  const runs = payloads
    .map(parseRun)
    .filter((run): run is ParsedRun => run !== null)
    .filter((run) => {
      const startMs = Date.parse(run.startDate);
      return startMs >= windowStart && startMs <= nowMs;
    })
    .sort(
      (a, b) =>
        Date.parse(b.startDate) - Date.parse(a.startDate) || b.id - a.id,
    );
  const distanceM = runs.reduce((sum, run) => sum + run.distanceM, 0);
  return {
    runs: runs.map((run) => ({
      ...run,
      ...insights(run, distanceM, context, nowMs),
    })),
    total: {
      count: runs.length,
      distanceM,
      movingTimeS: runs.reduce((sum, run) => sum + run.movingTimeS, 0),
      ...elevationTotal(runs),
    },
  };
}
