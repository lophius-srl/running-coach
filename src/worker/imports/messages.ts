// Messages en français de POST /api/imports/fit, affichés tels quels par le Raccourci iOS et
// l'onglet Import. Date de la séance dans le fuseau de l'utilisateur (Europe/Paris).

import { APP_TIME_ZONE } from "../goals/rules";
import type { FitImportStatus, ImportedActivity } from "./types";

export const MAX_FIT_BYTES = 1.5 * 1024 * 1024; // 1,5 Mio (ADR 0005, amendement #67)
export const DAILY_IMPORT_QUOTA = 30;

// « 23 oct. 2026 »
export function formatSessionDay(startDate: string): string {
  return new Date(startDate).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: APP_TIME_ZONE,
  });
}

// 13 106 m → « 13,1 km » (au dixième).
function formatKm(distanceM: number): string {
  return `${(Math.round(distanceM / 100) / 10).toFixed(1).replace(".", ",")} km`;
}

// 6 245 s → « 1:44:05 » ; 3 130 s → « 52:10 ».
export function formatClock(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = `${pad(seconds % 60)}`;
  return hours > 0 ? `${hours}:${pad(minutes)}:${rest}` : `${minutes}:${rest}`;
}

export function importedMessage(activity: ImportedActivity): string {
  return (
    `Séance du ${formatSessionDay(activity.startDate)} importée : ` +
    `${formatKm(activity.distanceM)} en ${formatClock(activity.movingTimeS)}`
  );
}

export function duplicateMessage(activity: ImportedActivity): string {
  return `Séance du ${formatSessionDay(activity.startDate)} déjà importée : rien n'a changé.`;
}

type FixedStatus = Exclude<FitImportStatus, "imported" | "duplicate">;

export const FIXED_MESSAGES: Record<FixedStatus, string> = {
  not_fit:
    "Ce fichier n'est pas un fichier FIT. Dans l'app Suunto, exporte la séance au format FIT.",
  invalid:
    "Fichier FIT illisible (incomplet ou corrompu). Exporte à nouveau la séance depuis l'app Suunto.",
  quota: `Limite de ${DAILY_IMPORT_QUOTA} envois en 24 h atteinte. Réessaie plus tard.`,
  unauthorized:
    "Envoi refusé : jeton absent ou invalide. Regénère ton jeton dans l'onglet Import de Running Coach et colle-le dans le Raccourci.",
  too_large: "Fichier trop gros : 1,5 Mo au maximum pour une séance.",
  unsupported_type:
    "Format d'envoi refusé : envoie le fichier FIT brut (corps « Fichier ») ou en formulaire (champ « file »).",
  error:
    "Erreur du serveur : la séance n'a pas été importée. Réessaie dans un moment.",
};

export const SINGLE_FILE_MESSAGE =
  "Envoie un seul fichier FIT par envoi, dans le champ « file ».";
