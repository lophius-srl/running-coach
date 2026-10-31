// Réponse de GET et POST /api/plan, partagée par l'API et le front (sans type Cloudflare).

import type { PaceRange, TrainingPaces } from "../../core/paces";
import {
  SESSION_ZONE,
  type PlannedSession,
  type WeekPlan,
} from "../../core/plan";

export type PlanSessionView = PlannedSession & {
  targetPace: PaceRange | null; // null sans allures (aucune course exploitable)
};

export type PlanView = Omit<WeekPlan, "sessions"> & {
  sessions: PlanSessionView[];
};

export type PlanResponse = { plan: PlanView | null };

// Refus de génération (409) : pas d'objectif, pas d'allures, ou course passée.
export type PlanError = "no_goal" | "no_paces" | "race_passed";

// Allures cibles ajoutées à la lecture, depuis les allures du moment : elles dérivent des
// activités Strava et ne sont donc jamais stockées avec le plan (ADR 0003).
export function withTargetPaces(
  plan: WeekPlan,
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
