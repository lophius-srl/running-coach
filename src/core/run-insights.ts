// Indicateurs d'une sortie (#60) : fonctions pures, sans I/O. Calculés à la volée depuis les
// données Strava des 7 derniers jours, jamais stockés ni envoyés à un LLM (ADR 0003).

import type { HeartRateZone } from "./heart-rate";
import { oxygenCost, ZONE_VDOT_SHARES } from "./paces";

export type PaceZone =
  "recovery" | "endurance" | "tempo" | "threshold" | "above_threshold" | "vma";

// Zone d'allure de la sortie selon le niveau actuel : part du VDOT que coûte l'allure moyenne
// (mêmes pourcentages que les allures affichées, src/core/paces.ts). Entre deux zones publiées,
// la sortie tombe dans « tempo » (entre endurance et seuil) ou « above_threshold ».
export function paceZone(
  paceSPerKm: number | null,
  vdot: number | null,
): PaceZone | null {
  if (paceSPerKm === null || vdot === null || paceSPerKm <= 0 || vdot <= 0) {
    return null;
  }
  const share = oxygenCost(60000 / paceSPerKm) / vdot;
  const { endurance, threshold, vma } = ZONE_VDOT_SHARES;
  if (share < endurance[0]) return "recovery";
  if (share <= endurance[1]) return "endurance";
  if (share < threshold[0]) return "tempo";
  if (share <= threshold[1]) return "threshold";
  if (share < vma[0]) return "above_threshold";
  return "vma";
}

// Numéro (1 à 5) de la zone cardiaque de la FC : dernière zone dont la borne basse est atteinte
// (zones contiguës, au-dessus de Z5 → 5) ; null sous Z1 ou sans zones ni FC.
export function heartRateZone(
  heartrate: number | null,
  zones: readonly HeartRateZone[] | null,
): number | null {
  if (heartrate === null || zones === null) return null;
  const reached = zones.filter((zone) => heartrate >= zone.low).length;
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
