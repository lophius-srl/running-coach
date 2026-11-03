// Fusion des séances de la montre (FIT, ADR 0005) avec les courses Strava : fonctions pures,
// déterministes, sans I/O. S'applique APRÈS mergeRuns (historique importé + API, par id Strava).
//
// Rapprochement : écart de départ ≤ 5 min ET écart de distance ≤ 5 % (de la distance montre) ou
// ≤ 200 m. Si plusieurs paires sont possibles, la plus proche en heure de départ l'emporte et chaque
// séance n'est utilisée qu'une fois. Priorité : les mesures viennent de la montre, le nom et l'id de
// Strava. Une séance montre sans équivalent reçoit l'id -watch_activities.id (les ids Strava sont
// positifs). Seules les courses (RUN_TYPES) de la montre sont prises en compte.
// ADR 0003 : calculé à la lecture, jamais stocké, jamais envoyé à un LLM.

import type { RunSample } from "./fitness";
import { RUN_TYPES } from "./run-types";

export const MATCH_MAX_START_GAP_MS = 5 * 60 * 1000;
export const MATCH_MAX_DISTANCE_GAP_PERCENT = 5;
export const MATCH_MAX_DISTANCE_GAP_M = 200;
export const WATCH_RUN_NAME = "Séance Suunto";

// Mesures d'une séance montre ; `id` est celui de watch_activities (positif).
export type WatchRunSample = RunSample & {
  elevationGainM: number | null;
  averageHeartrate: number | null;
};

// Une course fusionnée : Strava seule, montre seule, ou les deux rapprochées.
export type WatchPair<S, W> =
  { strava: S; watch: W | null } | { strava: null; watch: W };

export function isWatchOnly<S, W>(
  pair: WatchPair<S, W>,
): pair is { strava: null; watch: W } {
  return pair.strava === null;
}

// Id d'une séance montre sans équivalent Strava : négatif, donc sans collision.
export const watchRunId = (watchId: number) => -watchId;

type Dated<T> = { run: T; startMs: number };

// Date illisible rangée en dernier (+∞) : le tri reste cohérent et la fenêtre glissante aussi.
function startMsOf(run: RunSample): number {
  const ms = Date.parse(run.startDate);
  return Number.isNaN(ms) ? Infinity : ms;
}

function byStart<T extends RunSample>(runs: readonly T[]): Dated<T>[] {
  return runs
    .map((run) => ({ run, startMs: startMsOf(run) }))
    .sort((a, b) => a.startMs - b.startMs || a.run.id - b.run.id);
}

// Écart de distance comparé sans division (× 100) : calcul flottant, exact aux bornes en pratique
// (distances au mètre ou au centimètre).
function distanceMatches(watchM: number, stravaM: number): boolean {
  const gap = Math.abs(watchM - stravaM);
  return (
    gap <= MATCH_MAX_DISTANCE_GAP_M ||
    gap * 100 <= MATCH_MAX_DISTANCE_GAP_PERCENT * watchM
  );
}

type Candidate = { gapMs: number; w: number; s: number };

// Paires possibles, en une passe sur les deux listes triées (fenêtre glissante de ± 5 min).
function candidates(
  strava: Dated<RunSample>[],
  watch: Dated<RunSample>[],
): Candidate[] {
  const found: Candidate[] = [];
  let first = 0;
  watch.forEach((w, wi) => {
    while (
      first < strava.length &&
      strava[first].startMs < w.startMs - MATCH_MAX_START_GAP_MS
    ) {
      first += 1;
    }
    for (let si = first; si < strava.length; si += 1) {
      const gapMs = strava[si].startMs - w.startMs;
      if (gapMs > MATCH_MAX_START_GAP_MS) break;
      // Deux dates illisibles (∞ − ∞ = NaN) : pas de rapprochement, chaque séance reste seule.
      if (!(Math.abs(gapMs) <= MATCH_MAX_START_GAP_MS)) continue;
      if (distanceMatches(w.run.distanceM, strava[si].run.distanceM)) {
        found.push({ gapMs: Math.abs(gapMs), w: wi, s: si });
      }
    }
  });
  // Départ le plus proche d'abord ; à égalité, ordre des listes triées (déterministe).
  return found.sort((a, b) => a.gapMs - b.gapMs || a.w - b.w || a.s - b.s);
}

// Rapproche les courses Strava et les séances montre ; les séances montre non-course sont ignorées.
// Coût : tri des deux listes, puis une passe O(n + m) ; les paires candidates (quelques-unes par
// fenêtre de 5 min) sont triées pour départager les ambiguïtés.
export function pairWatchRuns<S extends RunSample, W extends RunSample>(
  strava: readonly S[],
  watch: readonly W[],
): WatchPair<S, W>[] {
  const sortedStrava = byStart(strava);
  const sortedWatch = byStart(
    watch.filter((run) => RUN_TYPES.has(run.sportType)),
  );
  const watchOf = new Map<number, W>();
  const usedWatch = new Set<number>();
  for (const { w, s } of candidates(sortedStrava, sortedWatch)) {
    if (usedWatch.has(w) || watchOf.has(s)) continue;
    usedWatch.add(w);
    watchOf.set(s, sortedWatch[w].run);
  }
  const pairs: WatchPair<S, W>[] = sortedStrava.map(({ run }, s) => ({
    strava: run,
    watch: watchOf.get(s) ?? null,
  }));
  sortedWatch.forEach(({ run }, w) => {
    if (!usedWatch.has(w)) pairs.push({ strava: null, watch: run });
  });
  return pairs;
}

// Mesures de la montre sur la course Strava (nom, id et type gardés) ; D+ et FC Strava en repli.
function withWatchMeasures<S extends RunSample>(
  strava: S,
  watch: WatchRunSample,
): S {
  const fallback: Partial<WatchRunSample> = strava;
  return {
    ...strava,
    startDate: watch.startDate,
    distanceM: watch.distanceM,
    movingTimeS: watch.movingTimeS,
    elevationGainM: watch.elevationGainM ?? fallback.elevationGainM ?? null,
    averageHeartrate:
      watch.averageHeartrate ?? fallback.averageHeartrate ?? null,
  };
}

// Courses Strava (déjà fusionnées par mergeRuns) et séances montre, sans doublon. Ordre de sortie
// NON chronologique : courses Strava par départ, puis séances montre seules par départ. Trier au
// besoin.
export function mergeWatchRuns<S extends RunSample>(
  strava: readonly S[],
  watch: readonly WatchRunSample[],
): (S | WatchRunSample)[] {
  return pairWatchRuns(strava, watch).map((pair) => {
    if (isWatchOnly(pair)) {
      return { ...pair.watch, id: watchRunId(pair.watch.id) };
    }
    return pair.watch === null
      ? pair.strava
      : withWatchMeasures(pair.strava, pair.watch);
  });
}
