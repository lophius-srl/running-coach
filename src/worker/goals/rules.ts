// Règles pures de l'objectif (sans I/O ni type Cloudflare) : partagées par l'API et le formulaire.

import type { PaceBasis } from "../../core/fitness";
import type { TrainingPaces } from "../../core/paces";

// Distances en mètres entiers. Le semi (21 097,5 m) est arrondi au mètre supérieur : 21 098.
// Plus rapide que le record du monde masculin (arrondi à la seconde) = chrono incohérent.
export const RACE_DISTANCES = [
  { distanceM: 5000, label: "5 km", worldRecordS: 755 },
  { distanceM: 10000, label: "10 km", worldRecordS: 1571 },
  { distanceM: 21098, label: "Semi-marathon", worldRecordS: 3402 },
  { distanceM: 42195, label: "Marathon", worldRecordS: 7235 },
] as const;

// Plus lent que 15 min/km = chrono incohérent (au-delà, c'est de la marche).
export const SLOWEST_PACE_S_PER_KM = 15 * 60;

export const WEEK_DAYS = [
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
  "Dimanche",
] as const; // index + 1 = jour ISO (1 = lundi … 7 = dimanche)

export const MIN_AVAILABLE_DAYS = 2;

export type Goal = {
  distanceM: number;
  raceDate: string; // AAAA-MM-JJ
  targetTimeS: number | null; // optionnel : null = finir la course, sans chrono visé
  availableDays: number[]; // jours ISO, uniques, triés
};

// Réponse de GET et PUT /api/goal.
export type GoalResponse = {
  goal: Goal | null;
  paces: TrainingPaces | null; // null sans objectif ou sans course exploitable
  basis: PaceBasis | null; // null sans course exploitable sur 8 semaines
};

export type GoalField = keyof Goal;
export type GoalErrors = Partial<Record<GoalField, string>>;
export type GoalValidation =
  { ok: true; goal: Goal } | { ok: false; errors: GoalErrors };

// « h:mm:ss » ou « mm:ss » → secondes ; null si le format est invalide.
export function parseDuration(text: string): number | null {
  const match = /^(?:(\d+):([0-5]\d)|(\d+)):([0-5]\d)$/.exec(text.trim());
  if (!match) return null;
  const [, hours, minutesWithHours, minutesOnly, seconds] = match;
  const minutes = Number(minutesWithHours ?? minutesOnly);
  return Number(hours ?? 0) * 3600 + minutes * 60 + Number(seconds);
}

// Fuseau de l'utilisateur (app mono-utilisateur, propriétaire en France) : « aujourd'hui »
// pour la validation de l'objectif et le plan de la semaine.
export const APP_TIME_ZONE = "Europe/Paris";

// Date calendaire (AAAA-MM-JJ) d'un instant dans un fuseau ; « en-CA » formate en AAAA-MM-JJ.
export function localIsoDate(nowMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(nowMs);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function raceDistance(value: unknown) {
  return RACE_DISTANCES.find((race) => race.distanceM === value);
}

const TIME_FORMAT = "au format h:mm:ss ou mm:ss";

// Erreur du chrono `value` sur `distanceM` (distance supposée valide), ou null.
function timeError(value: unknown, distanceM: number): string | null {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return `Saisis un chrono ${TIME_FORMAT}.`;
  }
  const race = raceDistance(distanceM);
  if (race && (value as number) < race.worldRecordS) {
    return `Ce chrono est plus rapide que le record du monde du ${race.label}.`;
  }
  if ((value as number) > (distanceM / 1000) * SLOWEST_PACE_S_PER_KM) {
    return "Ce chrono correspond à une allure plus lente que 15 min/km.";
  }
  return null;
}

function daysError(value: unknown): string | null {
  const valid =
    Array.isArray(value) &&
    value.length <= WEEK_DAYS.length &&
    value.every((day) => Number.isInteger(day) && day >= 1 && day <= 7) &&
    new Set(value).size === value.length;
  if (!valid) return "Jours disponibles invalides.";
  if (value.length < MIN_AVAILABLE_DAYS) {
    return `Coche au moins ${MIN_AVAILABLE_DAYS} jours disponibles.`;
  }
  return null;
}

// Valide une saisie non fiable ; les champs inconnus (dont l'ancien chrono de référence, #46)
// sont ignorés. La course doit être strictement après `today` (AAAA-MM-JJ) :
// une course le jour même ne laisse aucune séance à planifier.
export function validateGoal(input: unknown, today: string): GoalValidation {
  const raw = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<GoalField, unknown>;
  const errors: GoalErrors = {};
  // Clé absente = pas de chrono visé, comme null.
  const targetTimeS = raw.targetTimeS ?? null;

  const distance = raceDistance(raw.distanceM);
  if (!distance) errors.distanceM = "Choisis une distance cible.";

  // Fuseau : le serveur passe la date du jour à Paris (APP_TIME_ZONE), le front sa date locale
  // (identique en France). Seule la validation serveur fait foi ; celle du front sert à l'affichage.
  if (!isIsoDate(raw.raceDate)) {
    errors.raceDate = "Saisis une date de course valide.";
  } else if (raw.raceDate <= today) {
    errors.raceDate = "La date de course doit être dans le futur.";
  }

  if (distance && targetTimeS !== null) {
    const error = timeError(targetTimeS, distance.distanceM);
    if (error) errors.targetTimeS = error;
  }

  const dayError = daysError(raw.availableDays);
  if (dayError) errors.availableDays = dayError;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    goal: {
      distanceM: raw.distanceM as number,
      raceDate: raw.raceDate as string,
      targetTimeS: targetTimeS as number | null,
      availableDays: [...(raw.availableDays as number[])].sort((a, b) => a - b),
    },
  };
}
