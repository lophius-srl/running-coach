// « Derniers imports » de l'onglet Import (ADR 0005) : lecture et libellés, testés sans React.

import { formatClock, formatSessionDay } from "../worker/imports/messages";
import type {
  LoggedImportStatus,
  RecentImport,
  RecentImportsResponse,
} from "../worker/imports/types";
import { formatDistance, formatStartDate } from "./format";

export const IMPORT_STATUS_LABELS: Record<LoggedImportStatus, string> = {
  imported: "Importée",
  duplicate: "Déjà importée",
  not_fit: "Pas un fichier FIT",
  invalid: "Fichier illisible",
  quota: "Limite du jour atteinte",
};

const SPORT_LABELS: Record<string, string> = {
  Run: "Course",
  TrailRun: "Trail",
  VirtualRun: "Tapis",
  Ride: "Vélo",
  Walk: "Marche",
  Hike: "Randonnée",
  Swim: "Natation",
};

export type RecentImportLine = {
  receivedAt: string; // date de réception lisible
  status: string;
  ok: boolean;
  session: string | null; // « Trail du 3 nov. 2026 · 10,20 km en 52:10 »
};

export function recentImportLine(
  item: RecentImport,
  timeZone?: string,
): RecentImportLine {
  const { activity } = item;
  return {
    receivedAt: formatStartDate(item.receivedAt, timeZone),
    status: IMPORT_STATUS_LABELS[item.status],
    ok: item.status === "imported" || item.status === "duplicate",
    session:
      activity === null
        ? null
        : `${SPORT_LABELS[activity.sportType] ?? "Séance"} du ${formatSessionDay(activity.startDate)}` +
          ` · ${formatDistance(activity.distanceM)} en ${formatClock(activity.movingTimeS)}`,
  };
}

export async function fetchRecentImports(): Promise<RecentImport[]> {
  const response = await fetch("/api/imports/fit");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ((await response.json()) as RecentImportsResponse).imports;
}
