// Règles pures du tableau « mes runs des 7 derniers jours » (sans I/O).
// Lit le payload brut Strava stocké par la synchro et n'en garde que les champs affichés, puis y
// fusionne les séances de la montre (ADR 0005) : mesures de la montre, autres champs de Strava.

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
import {
  isWatchOnly,
  pairWatchRuns,
  WATCH_RUN_NAME,
  watchRunId,
  type WatchRunSample,
} from "../../core/watch-merge";
import { RETENTION_DAYS } from "../sync/rules";

const WINDOW_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Séance de la montre, avec les mesures en plus affichées sur la carte (src/worker/goals/fitness).
export type WatchRow = WatchRunSample & {
  elapsedTimeS: number;
  maxHeartrate: number | null;
};

export type RunSurface = "road" | "trail" | "treadmill";
export type RunWorkout = "race" | "long" | "intervals";

// Champs lus dans le payload Strava. Un champ absent, d'un autre type, négatif ou non fini → null.
export type ParsedRun = {
  id: number; // id Strava ; négatif pour une séance montre sans équivalent Strava (pas de lien)
  name: string;
  startDate: string; // ISO 8601, tel que renvoyé par Strava (start_date, UTC)
  // Heure locale du départ (start_date_local) : Strava la suffixe d'un faux « Z », elle s'affiche
  // donc en UTC. null si absente ou illisible.
  startDateLocal: string | null;
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
  maxPaceSPerKm: number | null; // depuis max_speed (m/s), écartée si incohérente
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
  paceZone: PaceZone | null; // selon le niveau actuel ; null en trail et en fractionné
  heartRateZone: number | null; // 1 à 5, si les zones cardiaques sont définies
  metersPerBeat: number | null;
  vdot: number | null; // si la sortie est exploitable (src/core/fitness.ts) ; null en trail
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

// Pauses : temps écoulé − temps de déplacement, jamais négatif.
const pauseOf = (elapsedTimeS: number | null, movingTimeS: number) =>
  elapsedTimeS === null ? null : Math.max(0, elapsedTimeS - movingTimeS);

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

// Format de start_date_local renvoyé par Strava (heure locale suffixée d'un faux « Z »).
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// Pic de vitesse jugé aberrant (GPS) au-delà de 3 fois la vitesse moyenne.
const MAX_SPEED_RATIO = 3;

// Allure max depuis max_speed (m/s) ; null si absente, plus lente que l'allure moyenne ou
// aberrante.
function maxPace(
  maxSpeed: number | null,
  distanceM: number,
  movingTimeS: number,
) {
  if (maxSpeed === null || distanceM <= 0 || movingTimeS <= 0) return null;
  const averageSpeed = distanceM / movingTimeS;
  if (maxSpeed < averageSpeed || maxSpeed > MAX_SPEED_RATIO * averageSpeed) {
    return null;
  }
  return 1000 / maxSpeed;
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
  const { start_date_local: local } = raw;
  const cadence = positive(raw.average_cadence);
  const altitudes = altitudeRange(finite(raw.elev_low), finite(raw.elev_high));
  return {
    id: id as number,
    name: typeof name === "string" ? name : "",
    startDate: start_date,
    startDateLocal:
      typeof local === "string" && LOCAL_DATE.test(local) ? local : null,
    sportType: sportType ?? "",
    surface: surface(sportType ?? "", raw.trainer),
    workout: WORKOUTS.get(raw.workout_type) ?? null,
    distanceM: distance,
    movingTimeS: moving_time,
    elapsedTimeS,
    pauseS: pauseOf(elapsedTimeS, moving_time),
    paceSPerKm: paceSecondsPerKm(distance, moving_time),
    maxPaceSPerKm: maxPace(positive(raw.max_speed), distance, moving_time),
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
  // En trail, le D+ fausse l'allure ; en fractionné, la moyenne mêle efforts et récupérations.
  const paceIsMeaningful =
    run.surface !== "trail" && run.workout !== "intervals";
  return {
    paceZone: paceIsMeaningful ? paceZone(run.paceSPerKm, context.vdot) : null,
    heartRateZone: heartRateZone(run.averageHeartrate, context.heartRateZones),
    metersPerBeat: metersPerBeat(
      run.distanceM,
      run.movingTimeS,
      run.averageHeartrate,
    ),
    vdot: run.surface === "trail" ? null : runVdot(run, nowMs),
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

// Carte Strava enrichie des mesures de la montre ; champs Strava en repli quand la montre n'en a
// pas. L'heure locale est décalée du même écart que le départ.
function withWatch(run: ParsedRun, watch: WatchRow): ParsedRun {
  const shiftMs = Date.parse(watch.startDate) - Date.parse(run.startDate);
  const local =
    run.startDateLocal === null
      ? null
      : new Date(Date.parse(run.startDateLocal) + shiftMs)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z");
  const elevationGainM = watch.elevationGainM ?? run.elevationGainM;
  return {
    ...run,
    startDate: watch.startDate,
    startDateLocal: local,
    distanceM: watch.distanceM,
    movingTimeS: watch.movingTimeS,
    elapsedTimeS: watch.elapsedTimeS,
    pauseS: pauseOf(watch.elapsedTimeS, watch.movingTimeS),
    paceSPerKm: paceSecondsPerKm(watch.distanceM, watch.movingTimeS),
    averageHeartrate: watch.averageHeartrate ?? run.averageHeartrate,
    maxHeartrate: watch.maxHeartrate ?? run.maxHeartrate,
    elevationGainM,
    elevationPerKm: elevationPerKm(elevationGainM, watch.distanceM),
  };
}

// Carte d'une séance montre sans équivalent Strava : les champs propres à Strava restent vides.
function watchOnlyRun(watch: WatchRow): ParsedRun {
  return {
    id: watchRunId(watch.id),
    name: WATCH_RUN_NAME,
    startDate: watch.startDate,
    startDateLocal: null,
    sportType: watch.sportType,
    surface: surface(watch.sportType, false),
    workout: null,
    distanceM: watch.distanceM,
    movingTimeS: watch.movingTimeS,
    elapsedTimeS: watch.elapsedTimeS,
    pauseS: pauseOf(watch.elapsedTimeS, watch.movingTimeS),
    paceSPerKm: paceSecondsPerKm(watch.distanceM, watch.movingTimeS),
    maxPaceSPerKm: null,
    averageHeartrate: watch.averageHeartrate,
    maxHeartrate: watch.maxHeartrate,
    cadenceSpm: null,
    elevationGainM: watch.elevationGainM,
    elevationPerKm: elevationPerKm(watch.elevationGainM, watch.distanceM),
    elevLowM: null,
    elevHighM: null,
    sufferScore: null,
    prCount: null,
    achievementCount: null,
    kudosCount: null,
  };
}

// Cartes Strava et séances montre fusionnées (src/core/watch-merge), avant le filtre des 7 jours.
function mergedRuns(payloads: string[], watch: WatchRow[]): ParsedRun[] {
  const parsed = payloads
    .map(parseRun)
    .filter((run): run is ParsedRun => run !== null);
  return pairWatchRuns(parsed, watch).map((pair) => {
    if (isWatchOnly(pair)) return watchOnlyRun(pair.watch);
    return pair.watch === null
      ? pair.strava
      : withWatch(pair.strava, pair.watch);
  });
}

// Courses parties dans les 7 derniers jours, de la plus récente à la plus ancienne (à départ
// identique, id décroissant pour un ordre stable), leurs indicateurs et leurs totaux.
export function summarizeRecentRuns(
  payloads: string[],
  nowMs: number,
  context: RunContext = { vdot: null, heartRateZones: null },
  watch: WatchRow[] = [],
): RecentRuns {
  const windowStart = nowMs - WINDOW_MS;
  const runs = mergedRuns(payloads, watch)
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
