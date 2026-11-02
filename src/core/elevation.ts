// Dénivelé positif (D+) : fonctions pures, sans I/O. Calculé à la volée depuis les données
// Strava, jamais stocké (ADR 0003).

// Mètres de D+ par kilomètre, arrondis à l'entier (245 m sur 8,45 km → 29) ; null si le D+
// est inconnu, négatif ou non fini, ou la distance nulle ou non finie.
export function elevationPerKm(
  elevationGainM: number | null,
  distanceM: number,
): number | null {
  if (elevationGainM === null || !Number.isFinite(elevationGainM)) return null;
  if (elevationGainM < 0 || !Number.isFinite(distanceM) || distanceM <= 0) {
    return null;
  }
  // Multiplier avant de diviser : 7 m / 0,56 km donne 12,5 et non 12,499…, arrondi à 13.
  return Math.round((elevationGainM * 1000) / distanceM);
}
