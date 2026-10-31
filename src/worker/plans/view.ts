// Réponse de GET et POST /api/plan, partagée par l'API et le front (sans type Cloudflare).

import type { PaceRange, TrainingPaces } from "../../core/paces";
import { SESSION_ZONE } from "../../core/plan";
import type { AdjustedPlan, AdjustedSession } from "../../core/plan-adjust";

export type PlanSessionView = AdjustedSession & {
  targetPace: PaceRange | null; // null sans allures (aucune course exploitable)
};

export type PlanView = Omit<AdjustedPlan, "sessions"> & {
  sessions: PlanSessionView[];
};

export type PlanResponse = { plan: PlanView | null };

// Refus de génération (409) : pas d'objectif, aucun jour disponible, pas d'allures, ou course
// passée.
export type PlanError = "no_goal" | "no_days" | "no_paces" | "race_passed";

// Allures cibles et ajustement (src/core/plan-adjust) ajoutés à la lecture : ils dérivent des
// activités Strava et ne sont donc jamais stockés avec le plan (ADR 0003).
export function withTargetPaces(
  plan: AdjustedPlan,
  paces: TrainingPaces | null,
): PlanView {
  return {
    ...plan,
    sessions: plan.sessions.map((session) => ({
      ...session,
      targetPace: paces && paces[SESSION_ZONE[session.kind]],
    })),
  };
}
