// Formatage d'affichage du tableau de bord (fonctions pures, testées sans React).

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// 8 432 m → « 8,43 km ». Arrondi aux 10 m avant toFixed, qui arrondit mal les flottants
// (9 995 m → « 10,00 km », 1 005 m → « 1,01 km »).
export function formatDistance(distanceM: number): string {
  const km = Math.round(distanceM / 10) / 100;
  return `${km.toFixed(2).replace(".", ",")} km`;
}

// Durée en h:mm:ss, arrondie à la seconde (3 000 s → « 0:50:00 »).
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}:${pad2(minutes)}:${pad2(seconds % 60)}`;
}

// Allure en m:ss/km, arrondie à la seconde ; « – » si inconnue (distance nulle).
export function formatPace(secondsPerKm: number | null): string {
  if (secondsPerKm === null) return "–";
  const seconds = Math.round(secondsPerKm);
  return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}/km`;
}

// Date et heure de départ, dans le fuseau du navigateur par défaut.
export function formatStartDate(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

// Fréquence cardiaque moyenne arrondie (« 152 bpm ») ; « – » si la montre ne l'a pas mesurée.
export function formatHeartrate(averageHeartrate: number | null): string {
  if (averageHeartrate === null) return "–";
  return `${Math.round(averageHeartrate)} bpm`;
}
