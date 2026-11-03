// Progression (issue #61) : agrégats par semaine ou par mois, fonctions pures sans I/O.
//
// Sources : historique importé (ADR 0004) et activités Strava API des 7 derniers jours, fusionnées
// par id (src/core/fitness.ts : mergeRuns). Course à pied uniquement (RUN_TYPES). ADR 0003 : tout
// est calculé à la lecture, jamais stocké, jamais envoyé à un LLM.
//
// Coût : les courses sont triées une fois puis réparties par balayage ; le fuseau n'est consulté
// qu'aux bornes de périodes (formateur Intl réutilisé) ; le niveau glissant (VDOT) utilise une
// file monotone, donc l'ensemble reste linéaire après le tri.

import { FITNESS_WINDOW_DAYS, runVdot, type RunSample } from "./fitness";
import { RUN_TYPES } from "./run-types";

export type ProgressionRun = RunSample & {
  elevationGainM: number | null;
  averageHeartrate: number | null;
};

export const PERIODS = ["3m", "6m", "1y", "all"] as const;
export const GROUPINGS = ["week", "month"] as const;
export type Period = (typeof PERIODS)[number];
export type Grouping = (typeof GROUPINGS)[number];

export type ProgressionBucket = {
  start: string; // AAAA-MM-JJ : lundi de la semaine ou 1er du mois (heure de Paris)
  count: number;
  distanceM: number;
  movingTimeS: number;
  elevationGainM: number;
  longestM: number; // 0 sans course
  paceSPerKm: number | null; // temps total / distance totale (= moyenne pondérée par la distance)
  heartrate: number | null; // moyenne pondérée par le temps, sur les sorties avec FC
  vdot: number | null; // meilleure course des 8 semaines glissantes à la fin de la période
};

export type ProgressionResponse = {
  period: Period;
  group: Grouping;
  buckets: ProgressionBucket[];
  lastRunDate: string | null; // ISO 8601 UTC, dernière course connue (toutes sources)
  lastImportedRunDate: string | null; // dernière course de l'historique importé
  lastImportAt: string | null; // date du dernier import (imported_at le plus récent)
  historyStale: boolean; // dernier import absent ou plus ancien que la fenêtre de l'API
};

export const DAY_MS = 24 * 60 * 60 * 1000;
// Au-delà, les données API (7 jours, ADR 0003) ne comblent plus le trou depuis le dernier import.
export const HISTORY_STALE_DAYS = 7;
const PERIOD_BUCKETS: Record<
  Exclude<Period, "all">,
  Record<Grouping, number>
> = {
  "3m": { week: 13, month: 3 },
  "6m": { week: 26, month: 6 },
  "1y": { week: 52, month: 12 },
};

export function isPeriod(value: unknown): value is Period {
  return (PERIODS as readonly unknown[]).includes(value);
}

export function isGrouping(value: unknown): value is Grouping {
  return (GROUPINGS as readonly unknown[]).includes(value);
}

// --- Calendrier (dates AAAA-MM-JJ, arithmétique en UTC pour éviter tout effet de fuseau) ---

function toUtcMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  return fromUtcMs(toUtcMs(isoDate) + days * DAY_MS);
}

export function addMonths(isoDate: string, months: number): string {
  const date = new Date(toUtcMs(isoDate));
  return fromUtcMs(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
}

// Début de la période (lundi ou 1er du mois) qui contient `isoDate`.
export function bucketStart(isoDate: string, group: Grouping): string {
  if (group === "month") return `${isoDate.slice(0, 8)}01`;
  const isoWeekDay = (new Date(toUtcMs(isoDate)).getUTCDay() + 6) % 7; // 0 = lundi
  return addDays(isoDate, -isoWeekDay);
}

function nextBucket(start: string, group: Grouping): string {
  return group === "week" ? addDays(start, 7) : addMonths(start, 1);
}

// Horloge d'un fuseau : un seul formateur Intl par calcul (en créer un par appel coûte cher) ;
// format() plutôt que formatToParts(), cinq fois plus rapide. Sortie : « 2026-11-02, 00:30 ».
export function zoneClock(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  // Lecture de « 2026-11-02, 00:30 » ; un autre format (moteur Intl différent) lève une erreur
  // explicite plutôt que de ranger silencieusement les courses dans la mauvaise période.
  function wallClock(ms: number): { date: string; time: string } {
    const text = format.format(ms);
    const match = /^(\d{4}-\d{2}-\d{2}), (\d{2}:\d{2})$/.exec(text);
    if (!match) throw new Error(`Format de date Intl inattendu : « ${text} »`);
    return { date: match[1], time: match[2] };
  }
  // Décalage du fuseau à un instant (ex. +3 600 000 à Paris en hiver), à la minute près.
  function offsetMs(atMs: number): number {
    const { date, time } = wallClock(atMs);
    const wallMs = Date.parse(`${date}T${time}:00Z`);
    if (Number.isNaN(wallMs)) {
      throw new Error(`Date Intl illisible : « ${date}, ${time} »`);
    }
    return wallMs - (atMs - (((atMs % 60_000) + 60_000) % 60_000));
  }
  return {
    // Date calendaire locale (AAAA-MM-JJ) d'un instant.
    localDate: (ms: number): string => wallClock(ms).date,
    // Instant du minuit local de `isoDate` (les changements d'heure de Paris n'ont pas lieu à minuit).
    midnightMs: (isoDate: string): number => {
      const utcMidnight = toUtcMs(isoDate);
      return utcMidnight - offsetMs(utcMidnight);
    },
  };
}

// Instant de début de la première période affichée ; null pour « tout » (borné par la 1re course).
export function progressionStartMs(
  period: Period,
  group: Grouping,
  nowMs: number,
  timeZone: string,
): number | null {
  if (period === "all") return null;
  const clock = zoneClock(timeZone);
  const current = bucketStart(clock.localDate(nowMs), group);
  const count = PERIOD_BUCKETS[period][group] - 1;
  const first =
    group === "week"
      ? addDays(current, -7 * count)
      : addMonths(current, -count);
  return clock.midnightMs(first);
}

// Dernier import absent ou fait il y a plus de 7 jours : des courses peuvent manquer entre l'export
// et la fenêtre de l'API. On juge la date de l'import, pas celle de la dernière course importée,
// pour ne pas alerter après une simple pause.
export function isHistoryStale(
  lastImportAt: string | null,
  nowMs: number,
): boolean {
  if (lastImportAt === null) return true;
  return Date.parse(lastImportAt) < nowMs - HISTORY_STALE_DAYS * DAY_MS;
}

type TimedRun = { run: ProgressionRun; ms: number };
type Totals = {
  count: number;
  distanceM: number;
  movingTimeS: number;
  elevationGainM: number;
  longestM: number;
  hrWeighted: number; // Σ FC × temps
  hrTimeS: number; // Σ temps des sorties avec FC
};

function emptyTotals(): Totals {
  return {
    count: 0,
    distanceM: 0,
    movingTimeS: 0,
    elevationGainM: 0,
    longestM: 0,
    hrWeighted: 0,
    hrTimeS: 0,
  };
}

function addRun(totals: Totals, run: ProgressionRun): void {
  totals.count += 1;
  totals.distanceM += run.distanceM;
  totals.movingTimeS += run.movingTimeS;
  totals.elevationGainM += run.elevationGainM ?? 0;
  totals.longestM = Math.max(totals.longestM, run.distanceM);
  if (run.averageHeartrate !== null && run.movingTimeS > 0) {
    totals.hrWeighted += run.averageHeartrate * run.movingTimeS;
    totals.hrTimeS += run.movingTimeS;
  }
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function toBucket(
  start: string,
  totals: Totals,
  vdot: number | null,
): ProgressionBucket {
  return {
    start,
    count: totals.count,
    distanceM: Math.round(totals.distanceM),
    movingTimeS: Math.round(totals.movingTimeS),
    elevationGainM: Math.round(totals.elevationGainM),
    longestM: Math.round(totals.longestM),
    paceSPerKm:
      totals.distanceM > 0
        ? Math.round(totals.movingTimeS / (totals.distanceM / 1000))
        : null,
    heartrate:
      totals.hrTimeS > 0
        ? Math.round(totals.hrWeighted / totals.hrTimeS)
        : null,
    vdot: vdot === null ? null : round1(vdot),
  };
}

// Meilleur VDOT des 8 semaines précédant chaque fin de période (même règle qu'estimateFitness),
// par file monotone décroissante : chaque course entre et sort au plus une fois.
function rollingVdot(runs: readonly TimedRun[], endsMs: number[]) {
  const scored = runs.flatMap(({ run, ms }) => {
    const score = runVdot(run, ms); // fenêtre évaluée à la date de la course : toujours dedans
    return score === null ? [] : [{ ms, score }];
  });
  const queue: { ms: number; score: number }[] = [];
  let head = 0;
  let next = 0;
  return endsMs.map((endMs) => {
    while (next < scored.length && scored[next].ms <= endMs) {
      const item = scored[next++];
      while (queue.length > head && queue[queue.length - 1].score <= item.score)
        queue.pop();
      queue.push(item);
    }
    const windowStart = endMs - FITNESS_WINDOW_DAYS * DAY_MS;
    while (queue.length > head && queue[head].ms < windowStart) head += 1;
    return queue.length > head ? queue[head].score : null;
  });
}

// Séries de la période, de la première période à celle qui contient `nowMs` ; périodes vides à 0
// (null pour allure, FC et niveau). « tout » commence à la première course ; sans course : [].
export function buildProgression(
  runs: readonly ProgressionRun[],
  period: Period,
  group: Grouping,
  nowMs: number,
  timeZone: string,
): ProgressionBucket[] {
  const clock = zoneClock(timeZone);
  const timed = runs
    .filter((run) => RUN_TYPES.has(run.sportType))
    .map((run) => ({ run, ms: Date.parse(run.startDate) }))
    .filter(({ ms }) => Number.isFinite(ms) && ms <= nowMs)
    .sort((a, b) => a.ms - b.ms);

  const startMs = progressionStartMs(period, group, nowMs, timeZone);
  const firstDay =
    startMs === null
      ? timed.length > 0
        ? clock.localDate(timed[0].ms)
        : null
      : clock.localDate(startMs);
  if (firstDay === null) return [];

  const last = bucketStart(clock.localDate(nowMs), group);
  const starts: string[] = [];
  for (
    let s = bucketStart(firstDay, group);
    s <= last;
    s = nextBucket(s, group)
  )
    starts.push(s);
  const boundsMs = starts.map((s) => clock.midnightMs(s));
  boundsMs.push(clock.midnightMs(nextBucket(last, group)));

  const totals = starts.map(emptyTotals);
  let index = 0;
  for (const { run, ms } of timed) {
    if (ms < boundsMs[0]) continue;
    while (ms >= boundsMs[index + 1]) index += 1;
    addRun(totals[index], run);
  }
  const ends = boundsMs.slice(1).map((ms) => Math.min(ms - 1, nowMs));
  const vdots = rollingVdot(timed, ends);
  return starts.map((start, i) => toBucket(start, totals[i], vdots[i]));
}
