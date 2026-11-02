// Dénivelé positif (D+) : fonctions pures, sans I/O. Calculé à la volée depuis les données
// Strava, jamais stocké (ADR 0003).

// Mètres de D+ par kilomètre, arrondis à l'entier (245 m sur 8,45 km → 29) ; null si le D+
// est inconnu ou la distance nulle.
export function elevationPerKm(
  elevationGainM: number | null,
  distanceM: number,
): number | null {
  if (elevationGainM === null || distanceM <= 0) return null;
  return Math.round(elevationGainM / (distanceM / 1000));
}
