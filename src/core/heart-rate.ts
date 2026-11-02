// Zones cardiaques (issue #57) : fonctions pures, déterministes, sans I/O.
//
// FC repos, FC max et zones sont saisies par l'utilisateur (durables, ADR 0003) ; rien ne vient
// de Strava. L'outil de calcul applique la formule de Karvonen :
//   borne = FC repos + % × (FC max − FC repos), arrondie au bpm le plus proche.
// Zones contiguës : la borne haute d'une zone est la borne basse de la suivante (même valeur),
// d'où « sans chevauchement ni trou ».

import type { SessionKind } from "./plan";

export type HeartRateZone = { low: number; high: number }; // bpm

export type HeartRateSettings = {
  restingHr: number;
  maxHr: number;
  zones: HeartRateZone[]; // 5 zones, Z1 → Z5
};

// Réponse de GET et PUT /api/heart-rate-zones : null tant que rien n'est enregistré.
export type HeartRateResponse = { heartRate: HeartRateSettings | null };

export type HeartRateField = "restingHr" | "maxHr" | "zones";
// `zone` et `bound` : zone (1 à 5) et borne en cause dans `zones`, pour cibler le bon champ.
export type ZoneBound = "low" | "high";
export type HeartRateErrors = Partial<Record<HeartRateField, string>> & {
  zone?: number;
  bound?: ZoneBound;
};

type ZonesError = { message: string; zone?: number; bound?: ZoneBound };
export type HeartRateValidation =
  | { ok: true; settings: HeartRateSettings }
  | { ok: false; errors: HeartRateErrors };

// Zone cardiaque cible d'une séance du plan (numéro 1 à 5 et bornes en bpm).
export type HeartRateTarget = HeartRateZone & { zone: number };

export const RESTING_HR = { min: 30, max: 120 };
export const MAX_HR = { min: 120, max: 230 };

// Pourcentages de la réserve cardiaque (FC max − FC repos) aux limites des zones :
// Z1 récupération 50–60 %, Z2 endurance 60–70 %, Z3 tempo 70–80 %, Z4 seuil 80–90 %,
// Z5 VMA 90–100 %.
export const KARVONEN_PERCENTS = [50, 60, 70, 80, 90, 100] as const;
// En dessous de 10 bpm de réserve, l'arrondi au bpm donne des zones vides : pas de calcul.
export const MIN_KARVONEN_RESERVE = 10;

export const HEART_RATE_ZONES = [
  { label: "Z1", name: "Récupération" },
  { label: "Z2", name: "Endurance" },
  { label: "Z3", name: "Tempo" },
  { label: "Z4", name: "Seuil" },
  { label: "Z5", name: "VMA" },
] as const;

// Zone cible (1 à 5) par type de séance. L'allure spécifique dépend de la distance visée :
// 5 km → Z5 (proche de la VMA), 10 km et semi → Z4 (autour du seuil), marathon → Z3 (tempo).
const SESSION_HR_ZONE: Record<Exclude<SessionKind, "race_pace">, number> = {
  endurance: 2,
  long: 2,
  recovery: 1,
  threshold: 4,
  vma: 5,
};

export function raceHeartRateZone(distanceM: number): number {
  if (distanceM <= 5000) return 5;
  if (distanceM <= 21098) return 4;
  return 3;
}

// Zone de la séance, ou null pour une allure spécifique sans distance d'objectif connue.
export function sessionHeartRateZone(
  kind: SessionKind,
  raceDistanceM: number | null,
): number | null {
  if (kind !== "race_pace") return SESSION_HR_ZONE[kind];
  return raceDistanceM === null ? null : raceHeartRateZone(raceDistanceM);
}

export function karvonenZones(
  restingHr: number,
  maxHr: number,
): HeartRateZone[] {
  const reserve = maxHr - restingHr;
  const bounds = KARVONEN_PERCENTS.map((percent) =>
    Math.round(restingHr + (percent / 100) * reserve),
  );
  return bounds.slice(0, -1).map((low, index) => ({
    low,
    high: bounds[index + 1],
  }));
}

function isBpm(value: unknown): value is number {
  return Number.isInteger(value);
}

function rangeError(
  value: unknown,
  label: string,
  range: { min: number; max: number },
): string | null {
  if (!isBpm(value) || value < range.min || value > range.max) {
    return `Saisis ta ${label} en bpm, entre ${range.min} et ${range.max}.`;
  }
  return null;
}

function isZone(value: unknown): value is { low: unknown; high: unknown } {
  return typeof value === "object" && value !== null;
}

// Première erreur des zones (en les parcourant de Z1 à Z5), ou null.
function zonesError(
  zones: unknown,
  restingHr: number | null,
  maxHr: number | null,
): ZonesError | null {
  if (!Array.isArray(zones) || zones.length !== HEART_RATE_ZONES.length) {
    return { message: `Renseigne les ${HEART_RATE_ZONES.length} zones.` };
  }
  for (const [index, zone] of zones.entries()) {
    const { label } = HEART_RATE_ZONES[index];
    const error = (message: string, bound: ZoneBound = "low") => ({
      message,
      zone: index + 1,
      bound,
    });
    if (!isZone(zone) || !isBpm(zone.low) || !isBpm(zone.high)) {
      return error(
        `${label} : saisis les deux bornes en bpm (nombres entiers).`,
        isZone(zone) && isBpm(zone.low) ? "high" : "low",
      );
    }
    if (zone.low >= zone.high) {
      return error(
        `${label} : la borne basse doit être inférieure à la borne haute.`,
      );
    }
    const previous: unknown = zones[index - 1];
    if (isZone(previous) && previous.high !== zone.low) {
      return error(
        `${label} : la borne basse doit être égale à la borne haute de ${HEART_RATE_ZONES[index - 1].label} (${String(previous.high)} bpm), sans chevauchement ni trou.`,
      );
    }
  }
  const first = zones[0] as HeartRateZone;
  const last = zones[zones.length - 1] as HeartRateZone;
  if (restingHr !== null && first.low < restingHr) {
    return {
      message: `Z1 : la borne basse ne peut pas être sous ta FC repos (${restingHr} bpm).`,
      zone: 1,
      bound: "low",
    };
  }
  if (maxHr !== null && last.high > maxHr) {
    return {
      message: `Z5 : la borne haute ne peut pas dépasser ta FC max (${maxHr} bpm).`,
      zone: zones.length,
      bound: "high",
    };
  }
  return null;
}

// Valide une saisie non fiable (corps de PUT /api/heart-rate-zones ou formulaire). Les zones ne
// sont comparées à la FC repos / max que si celles-ci sont valides.
export function validateHeartRate(input: unknown): HeartRateValidation {
  const raw = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<HeartRateField, unknown>;
  const errors: HeartRateErrors = {};

  const restingError = rangeError(raw.restingHr, "FC repos", RESTING_HR);
  if (restingError) errors.restingHr = restingError;
  const maxError = rangeError(raw.maxHr, "FC max", MAX_HR);
  if (maxError) errors.maxHr = maxError;
  const restingHr = restingError ? null : (raw.restingHr as number);
  let maxHr = maxError ? null : (raw.maxHr as number);
  if (restingHr !== null && maxHr !== null && restingHr >= maxHr) {
    errors.maxHr = "Ta FC max doit être supérieure à ta FC repos.";
    maxHr = null;
  }

  const zoneError = zonesError(raw.zones, restingHr, maxHr);
  if (zoneError) {
    errors.zones = zoneError.message;
    if (zoneError.zone) errors.zone = zoneError.zone;
    if (zoneError.bound) errors.bound = zoneError.bound;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      restingHr: restingHr as number,
      maxHr: maxHr as number,
      zones: (raw.zones as HeartRateZone[]).map(({ low, high }) => ({
        low,
        high,
      })),
    },
  };
}
