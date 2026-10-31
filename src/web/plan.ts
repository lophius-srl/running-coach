// Libellés et formatage du plan de la semaine (fonctions pures, testées sans React).

import { addDays, type PlanPhase, type SessionKind } from "../core/plan";
import type { PlanError } from "../worker/plans/view";

export const SESSION_LABELS: Record<SessionKind, string> = {
  endurance: "Footing",
  recovery: "Récupération",
  long: "Sortie longue",
  threshold: "Seuil",
  vma: "Fractionné VMA",
  race_pace: "Allure spécifique",
};

export const PHASE_LABELS: Record<PlanPhase, string> = {
  development: "Développement : on construit l'endurance et la VMA.",
  specific: "Spécifique : on travaille l'allure de la course.",
  taper: "Affûtage : on réduit le volume pour arriver frais.",
};

const ERROR_MESSAGES: Record<PlanError, string> = {
  no_goal: "Enregistre d'abord ton objectif.",
  no_days: "Coche tes jours disponibles dans ton objectif.",
  no_paces: "Il faut d'abord tes allures : synchronise tes courses.",
  race_passed: "Ta course est passée : mets à jour ton objectif.",
};

export function planErrorMessage(error: unknown): string {
  return typeof error === "string" && Object.hasOwn(ERROR_MESSAGES, error)
    ? ERROR_MESSAGES[error as PlanError]
    : "Impossible de générer ton plan, réessaie plus tard.";
}

// Date calendaire (AAAA-MM-JJ) → « mardi 3 nov. », sans décalage de fuseau.
export function formatPlanDay(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

// Période couverte par le plan (7 jours) : « Du mardi 3 nov. au lundi 9 nov. ».
export function formatPlanPeriod(weekStart: string): string {
  return `Du ${formatPlanDay(weekStart)} au ${formatPlanDay(addDays(weekStart, 6))}`;
}

// Plan terminé : son dernier jour (weekStart + 6) est passé. `today` en AAAA-MM-JJ.
export function isPlanOver(weekStart: string, today: string): boolean {
  return addDays(weekStart, 6) < today;
}
