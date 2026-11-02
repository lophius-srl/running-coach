// Réponse de GET et POST /api/plan, partagée par l'API et le front (sans type Cloudflare).

import {
  sessionHeartRateZone,
  type HeartRateSettings,
  type HeartRateTarget,
} from "../../core/heart-rate";
import type { PaceRange, TrainingPaces } from "../../core/paces";
import { SESSION_ZONE } from "../../core/plan";
import type { AdjustedPlan, AdjustedSession } from "../../core/plan-adjust";

export type PlanSessionView = AdjustedSession & {
  targetPace: PaceRange | null; // null sans allures (aucune course exploitable)
  targetHeartRate: HeartRateTarget | null; // null sans zones cardiaques enregistrées
};

export type PlanView = Omit<AdjustedPlan, "sessions"> & {
  sessions: PlanSessionView[];
};

export type PlanResponse = { plan: PlanView | null };

// Refus de génération (409) : pas d'objectif, aucun jour disponible, pas d'allures, ou course
// passée.
export type PlanError = "no_goal" | "no_days" | "no_paces" | "race_passed";

// Zones cardiaques de l'utilisateur et distance de son objectif (zone de l'allure spécifique).
export type HeartRateContext = {
  settings: HeartRateSettings | null;
  raceDistanceM: number | null;
};

function heartRateTarget(
  kind: AdjustedSession["kind"],
  { settings, raceDistanceM }: HeartRateContext,
): HeartRateTarget | null {
  const zone = settings && sessionHeartRateZone(kind, raceDistanceM);
  return settings && zone ? { zone, ...settings.zones[zone - 1] } : null;
}

// Allures cibles et ajustement (src/core/plan-adjust) ajoutés à la lecture : ils dérivent des
// activités Strava et ne sont donc jamais stockés avec le plan (ADR 0003). La zone cardiaque
// cible l'est aussi, pour suivre les zones du moment sans stocker de bpm dans le plan.
export function withTargets(
  plan: AdjustedPlan,
  paces: TrainingPaces | null,
  heartRate: HeartRateContext,
): PlanView {
  return {
    ...plan,
    sessions: plan.sessions.map((session) => ({
      ...session,
      targetPace: paces && paces[SESSION_ZONE[session.kind]],
      targetHeartRate: heartRateTarget(session.kind, heartRate),
    })),
  };
}
