// Ajustement du plan selon les courses récentes (issue #16) : fonctions pures, sans I/O.
//
// Le plan de base (src/core/plan) est stocké tel quel ; l'ajustement dérive des activités Strava,
// il est donc recalculé à chaque lecture et jamais stocké (ADR 0003, point ouvert sur les agrégats).
//
// Règles :
// - Volume prévu = total des durées du plan de base ; volume réel = temps de déplacement des
//   courses (RUN_TYPES) parties dans les 7 derniers jours (historique importé et Strava fusionnés).
// - Réel > prévu × 1,6 → −25 % ; réel > prévu × 1,3 (« nettement supérieur ») → −15 %.
// - Aucune course depuis 7 jours, mais au moins une dans les 8 dernières semaines → reprise :
//   séances de qualité remplacées par du footing et durées −30 %. Sans aucune course connue sur
//   8 semaines (jamais synchronisé ni importé), on ne sait rien : pas d'ajustement.
// - La réduction porte sur les footings, récupérations et sortie longue : les séances de qualité
//   gardent leur contenu (répétitions fixées dans le descriptif).
// - Durées arrondies aux 5 min, au moins 20 min, jamais au-dessus de la durée prévue.

import { FITNESS_WINDOW_DAYS, type RunSample } from "./fitness";
import {
  HARD_KINDS,
  type PlannedSession,
  type SessionKind,
  type WeekPlan,
} from "./plan";
import { RUN_TYPES } from "./run-types";

export const RECENT_DAYS = 7;
// Seuils en pourcentage du volume prévu (comparaison entière, sans arrondi flottant).
export const HIGH_VOLUME_PERCENT = 130;
export const VERY_HIGH_VOLUME_PERCENT = 160;
export const HIGH_VOLUME_CUT = 0.15;
export const VERY_HIGH_VOLUME_CUT = 0.25;
export const RESTART_CUT = 0.3;
export const MIN_SESSION_MIN = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const RESTART_DESCRIPTION =
  "Footing en endurance à la place de la séance prévue : reprise en douceur après une semaine sans courir.";

export type PlanAdjustment = {
  kind: "high_volume" | "restart";
  reason: string;
};

export type AdjustedSession = PlannedSession & {
  // Séance prévue par le plan de base, quand l'ajustement l'a modifiée.
  planned: Pick<PlannedSession, "kind" | "durationMin"> | null;
};

export type AdjustedPlan = Omit<WeekPlan, "sessions"> & {
  sessions: AdjustedSession[];
  adjustment: PlanAdjustment | null;
};

function runsWithin(runs: readonly RunSample[], nowMs: number, days: number) {
  return runs.filter((run) => {
    const startMs = Date.parse(run.startDate);
    return (
      RUN_TYPES.has(run.sportType) &&
      startMs > nowMs - days * DAY_MS &&
      startMs <= nowMs
    );
  });
}

export function adjustedDuration(durationMin: number, cut: number): number {
  const rounded = Math.round((durationMin * (1 - cut)) / 5) * 5;
  return Math.min(durationMin, Math.max(MIN_SESSION_MIN, rounded));
}

function reshape(
  session: PlannedSession,
  cut: number,
  restart: boolean,
): AdjustedSession {
  const quality = HARD_KINDS.has(session.kind) && session.kind !== "long";
  if (quality && !restart) return { ...session, planned: null };
  const kind: SessionKind = quality ? "endurance" : session.kind;
  const durationMin = adjustedDuration(session.durationMin, cut);
  const changed = kind !== session.kind || durationMin !== session.durationMin;
  return {
    ...session,
    kind,
    durationMin,
    description: quality ? RESTART_DESCRIPTION : session.description,
    planned: changed
      ? { kind: session.kind, durationMin: session.durationMin }
      : null,
  };
}

function decide(
  plannedMin: number,
  runs: readonly RunSample[],
  nowMs: number,
): { cut: number; adjustment: PlanAdjustment } | null {
  if (plannedMin === 0) return null;
  const recent = runsWithin(runs, nowMs, RECENT_DAYS);
  if (recent.length === 0) {
    if (runsWithin(runs, nowMs, FITNESS_WINDOW_DAYS).length === 0) return null;
    return {
      cut: RESTART_CUT,
      adjustment: {
        kind: "restart",
        reason: `Aucune course depuis ${RECENT_DAYS} jours : reprise en douceur, séances de qualité remplacées par du footing et durées −${RESTART_CUT * 100} %.`,
      },
    };
  }
  const actualMin = Math.round(
    recent.reduce((sum, run) => sum + run.movingTimeS, 0) / 60,
  );
  if (actualMin * 100 <= plannedMin * HIGH_VOLUME_PERCENT) return null;
  const cut =
    actualMin * 100 > plannedMin * VERY_HIGH_VOLUME_PERCENT
      ? VERY_HIGH_VOLUME_CUT
      : HIGH_VOLUME_CUT;
  return {
    cut,
    adjustment: {
      kind: "high_volume",
      reason: `Volume récent élevé (${actualMin} min courues en ${RECENT_DAYS} jours pour ${plannedMin} min prévues) : footings et sortie longue −${cut * 100} %.`,
    },
  };
}

// Plan ajusté selon les courses des 7 derniers jours ; inchangé si aucune règle ne s'applique.
export function adjustPlan(
  plan: WeekPlan,
  runs: readonly RunSample[],
  nowMs: number,
): AdjustedPlan {
  const plannedMin = plan.sessions.reduce((sum, s) => sum + s.durationMin, 0);
  const decision = decide(plannedMin, runs, nowMs);
  return {
    ...plan,
    sessions: plan.sessions.map((session) =>
      decision
        ? reshape(session, decision.cut, decision.adjustment.kind === "restart")
        : { ...session, planned: null },
    ),
    adjustment: decision?.adjustment ?? null,
  };
}
