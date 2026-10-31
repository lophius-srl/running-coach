// Niveau estimé depuis les courses récentes : fonctions pures, déterministes, sans I/O.
//
// Sources : historique importé (ADR 0004) et activités Strava API des 7 derniers jours, fusionnées
// par id (la version API l'emporte). Pour chaque course exploitable des 8 dernières semaines,
// VDOT de Daniels (src/core/paces.ts) depuis la distance et le temps de déplacement ; on garde
// le meilleur. ADR 0003 : calculé à la volée, jamais stocké, jamais envoyé à un LLM.

import { vdot } from "./paces";
import { RUN_TYPES } from "./run-types";

export type RunSample = {
  id: number;
  startDate: string; // ISO 8601 UTC
  sportType: string;
  distanceM: number;
  movingTimeS: number;
};

// Course d'où vient le niveau, affichée pour expliquer les allures.
export type PaceBasis = Pick<
  RunSample,
  "startDate" | "distanceM" | "movingTimeS"
>;

export type Fitness = {
  vdot: number;
  run: RunSample; // course retenue, affichée pour expliquer le calcul
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const FITNESS_WINDOW_DAYS = 56; // 8 semaines glissantes

// Domaine de validité retenu pour la formule de Daniels (calée du 1 500 m au marathon).
// Plafond à 43 km et non 42,195 : le GPS surestime souvent un marathon de quelques centaines de m.
export const MIN_DISTANCE_M = 3000;
export const MAX_DISTANCE_M = 43_000;
export const MIN_DURATION_S = 8 * 60;
export const MAX_DURATION_S = 6 * 60 * 60;
// Plus lent que 15 min/km : de la marche (même borne que le chrono visé).
export const SLOWEST_PACE_S_PER_KM = 15 * 60;
// Plafond de VDOT : les records du monde du 3 km au marathon valent environ 84 à 87, donc
// au-delà de 85 la performance est jugée aberrante (GPS, vélo mal typé en course), quitte à
// écarter un niveau proche du record du monde.
export const MAX_VDOT = 85;

// Fusion par id : la version API (plus fraîche) remplace la version importée.
export function mergeRuns(
  imported: readonly RunSample[],
  api: readonly RunSample[],
): RunSample[] {
  const byId = new Map<number, RunSample>();
  for (const run of [...imported, ...api]) byId.set(run.id, run);
  return [...byId.values()];
}

// VDOT d'une course exploitable de la période, ou null si elle doit être ignorée.
export function runVdot(run: RunSample, nowMs: number): number | null {
  const startMs = Date.parse(run.startDate);
  const inWindow =
    startMs >= nowMs - FITNESS_WINDOW_DAYS * DAY_MS && startMs <= nowMs;
  if (!inWindow || !RUN_TYPES.has(run.sportType)) return null;
  const { distanceM, movingTimeS } = run;
  if (!(distanceM >= MIN_DISTANCE_M && distanceM <= MAX_DISTANCE_M)) {
    return null;
  }
  if (!(movingTimeS >= MIN_DURATION_S && movingTimeS <= MAX_DURATION_S)) {
    return null;
  }
  if (movingTimeS / (distanceM / 1000) > SLOWEST_PACE_S_PER_KM) return null;
  const score = vdot(distanceM, movingTimeS);
  return score <= MAX_VDOT ? score : null;
}

// À VDOT égal, la course la plus récente l'emporte, puis l'id le plus grand (ordre stable).
function isBetter(candidate: Fitness, best: Fitness | null): boolean {
  if (best === null) return true;
  if (candidate.vdot !== best.vdot) return candidate.vdot > best.vdot;
  const byDate =
    Date.parse(candidate.run.startDate) - Date.parse(best.run.startDate);
  return byDate !== 0 ? byDate > 0 : candidate.run.id > best.run.id;
}

// Meilleur niveau des 8 dernières semaines ; null sans course exploitable.
export function estimateFitness(
  runs: readonly RunSample[],
  nowMs: number,
): Fitness | null {
  let best: Fitness | null = null;
  for (const run of runs) {
    const score = runVdot(run, nowMs);
    if (score === null) continue;
    const candidate = { vdot: score, run };
    if (isBetter(candidate, best)) best = candidate;
  }
  return best;
}
