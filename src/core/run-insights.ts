// Indicateurs d'une sortie (#60) : fonctions pures, sans I/O. Calculés à la volée depuis les
// données Strava des 7 derniers jours, jamais stockés ni envoyés à un LLM (ADR 0003).

import type { HeartRateZone } from "./heart-rate";
import { zonePaces } from "./paces";

export type PaceZone =
  "recovery" | "endurance" | "tempo" | "threshold" | "above_threshold" | "vma";

// Zone d'allure de la sortie selon le niveau actuel. L'allure, arrondie à la seconde comme à
// l'affichage, est comparée aux fourchettes publiées (src/core/paces.ts), bornes incluses : une
// sortie courue pile à une borne affichée tombe dans la zone affichée. Entre deux zones publiées,
// la sortie tombe dans « tempo » (entre endurance et seuil) ou « above_threshold ».
export function paceZone(
  paceSPerKm: number | null,
  vdot: number | null,
): PaceZone | null {
  if (paceSPerKm === null || vdot === null || paceSPerKm <= 0 || vdot <= 0) {
    return null;
  }
  const pace = Math.round(paceSPerKm);
  const { endurance, threshold, vma } = zonePaces(vdot);
  if (pace > endurance.slowSPerKm) return "recovery";
  if (pace >= endurance.fastSPerKm) return "endurance";
  if (pace > threshold.slowSPerKm) return "tempo";
  if (pace >= threshold.fastSPerKm) return "threshold";
  if (pace > vma.slowSPerKm) return "above_threshold";
  return "vma";
}

// Numéro (1 à 5) de la zone cardiaque de la FC, arrondie au bpm comme à l'affichage : dernière
// zone dont la borne basse est atteinte (zones contiguës : une borne partagée appartient à la zone
// du dessus ; au-dessus de Z5 → 5) ; null sous Z1 ou sans zones ni FC.
export function heartRateZone(
  heartrate: number | null,
  zones: readonly HeartRateZone[] | null,
): number | null {
  if (heartrate === null || zones === null) return null;
  const bpm = Math.round(heartrate);
  const reached = zones.filter((zone) => bpm >= zone.low).length;
  return reached === 0 ? null : reached;
}

// Efficacité : mètres parcourus par battement cardiaque (vitesse en m/min ÷ FC moyenne).
export function metersPerBeat(
  distanceM: number,
  movingTimeS: number,
  averageHeartrate: number | null,
): number | null {
  if (averageHeartrate === null || averageHeartrate <= 0) return null;
  if (distanceM <= 0 || movingTimeS <= 0) return null;
  return distanceM / (movingTimeS / 60) / averageHeartrate;
}

// Part de la sortie dans la distance des 7 jours (0 à 1) ; null si la semaine est vide.
export function weekShare(distanceM: number, weekDistanceM: number) {
  return weekDistanceM > 0 ? distanceM / weekDistanceM : null;
}
