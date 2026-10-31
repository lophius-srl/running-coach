// Ajustement du plan selon les courses récentes (issue #16) : fonctions pures, sans I/O.
//
// Le plan de base (src/core/plan) est stocké tel quel ; l'ajustement dérive des activités Strava,
// il est donc recalculé à chaque lecture et jamais stocké (ADR 0003, point ouvert sur les agrégats).
//
// Fenêtre : les 7 × 24 h qui précèdent le début du plan (minuit, heure de Paris, du jour
// weekStart, calculé par l'appelant), et non les 7 jours avant maintenant. La décision reste
// ainsi la même toute la semaine du plan (les séances courues ensuite ne la changent pas), sans
// rien stocker. Fenêtre [début − N × 24 h, début[, avec N = 7, ou 56 pour « course connue ».
//
// Règles :
// - Volume prévu = total des durées du plan de base ; volume réel = temps de déplacement des
//   courses (RUN_TYPES) de la fenêtre de 7 jours (historique importé et Strava fusionnés).
// - Réel > prévu × 1,6 → −25 % ; réel > prévu × 1,3 (« nettement supérieur ») → −15 % ;
//   jamais en affûtage, qui réduit déjà le volume.
// - Aucune course dans la fenêtre de 7 jours, mais au moins une dans les 8 semaines avant le
//   plan → reprise : séances de qualité remplacées par du footing et durées −30 %. Sans aucune
//   course connue sur 8 semaines (jamais synchronisé ni importé), on ne sait rien : rien.
// - Seules les séances d'aujourd'hui et après sont modifiées : les séances passées restent
//   telles que prévues. Plan terminé, ou aucune séance modifiée → pas d'ajustement ni de raison.
// - La réduction porte sur les footings, récupérations et sortie longue : les séances de qualité
//   gardent leur contenu (répétitions fixées dans le descriptif).
// - Durées arrondies aux 5 min, au moins 20 min, jamais au-dessus de la durée prévue.

import { FITNESS_WINDOW_DAYS, type RunSample } from "./fitness";
import {
  addDays,
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

// Courses parties dans [planStartMs − days × 24 h, planStartMs[.
function runsBefore(
  runs: readonly RunSample[],
  planStartMs: number,
  days: number,
) {
  return runs.filter((run) => {
    const startMs = Date.parse(run.startDate);
    return (
      RUN_TYPES.has(run.sportType) &&
      startMs >= planStartMs - days * DAY_MS &&
      startMs < planStartMs
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
  plan: WeekPlan,
  runs: readonly RunSample[],
  planStartMs: number,
): { cut: number; adjustment: PlanAdjustment } | null {
  const plannedMin = plan.sessions.reduce((sum, s) => sum + s.durationMin, 0);
  if (plannedMin === 0) return null;
  const recent = runsBefore(runs, planStartMs, RECENT_DAYS);
  if (recent.length === 0) {
    if (runsBefore(runs, planStartMs, FITNESS_WINDOW_DAYS).length === 0) {
      return null;
    }
    return {
      cut: RESTART_CUT,
      adjustment: {
        kind: "restart",
        reason: `Aucune course enregistrée depuis ${RECENT_DAYS} jours : reprise en douceur, séances de qualité remplacées par du footing et durées −${RESTART_CUT * 100} %.`,
      },
    };
  }
  const actualMin = Math.round(
    recent.reduce((sum, run) => sum + run.movingTimeS, 0) / 60,
  );
  if (plan.phase === "taper") return null;
  if (actualMin * 100 <= plannedMin * HIGH_VOLUME_PERCENT) return null;
  const cut =
    actualMin * 100 > plannedMin * VERY_HIGH_VOLUME_PERCENT
      ? VERY_HIGH_VOLUME_CUT
      : HIGH_VOLUME_CUT;
  return {
    cut,
    adjustment: {
      kind: "high_volume",
      reason: `Volume récent élevé (${actualMin} min courues dans les ${RECENT_DAYS} jours avant le plan pour ${plannedMin} min prévues) : footings et sortie longue −${cut * 100} %.`,
    },
  };
}

const unchanged = (session: PlannedSession): AdjustedSession => ({
  ...session,
  planned: null,
});

// Plan ajusté selon les courses des 7 jours avant son début ; inchangé si aucune règle ne
// s'applique. `today` (AAAA-MM-JJ, heure de Paris) protège les séances passées.
export function adjustPlan(
  plan: WeekPlan,
  runs: readonly RunSample[],
  planStartMs: number,
  today: string,
): AdjustedPlan {
  const over = addDays(plan.weekStart, 6) < today;
  const decision = over ? null : decide(plan, runs, planStartMs);
  const sessions = plan.sessions.map((session) =>
    decision && session.date >= today
      ? reshape(session, decision.cut, decision.adjustment.kind === "restart")
      : unchanged(session),
  );
  const changed = sessions.some((session) => session.planned !== null);
  return {
    ...plan,
    sessions,
    adjustment: changed && decision ? decision.adjustment : null,
  };
}
