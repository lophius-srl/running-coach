// Onglet Progression (issue #61) : séries, libellés et résumés (fonctions pures, testées sans React).

import type { Grouping, Period, ProgressionBucket } from "../core/progression";
import { summarize, type Trend } from "./charts/scale";
import { formatDay, formatHeartrate, formatPace, formatVdot } from "./format";

export const PERIOD_OPTIONS: readonly { value: Period; label: string }[] = [
  { value: "3m", label: "3 mois" },
  { value: "6m", label: "6 mois" },
  { value: "1y", label: "1 an" },
  { value: "all", label: "Tout" },
];

export const GROUP_OPTIONS: readonly { value: Grouping; label: string }[] = [
  { value: "week", label: "Semaine" },
  { value: "month", label: "Mois" },
];

const dateOf = (start: string) => new Date(`${start}T00:00:00Z`);

// Libellé court de l'axe : « 26 oct. » par semaine ; « oct. » par mois, l'année en janvier.
export function bucketLabel(start: string, group: Grouping): string {
  const date = dateOf(start);
  if (group === "month" && date.getUTCMonth() === 0) {
    return String(date.getUTCFullYear());
  }
  return date.toLocaleDateString("fr-FR", {
    timeZone: "UTC",
    month: "short",
    ...(group === "week" ? { day: "numeric" } : {}),
  });
}

// Libellé complet : « semaine du 26 oct. 2026 », « octobre 2026 ».
export function bucketPeriod(start: string, group: Grouping): string {
  const date = dateOf(start);
  if (group === "month") {
    return date.toLocaleDateString("fr-FR", {
      timeZone: "UTC",
      month: "long",
      year: "numeric",
    });
  }
  const day = date.toLocaleDateString("fr-FR", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `semaine du ${day}`;
}

// Date du récapitulatif, compacte pour tenir à 320 px : « 02/11/2026 », « nov. 2026 ».
export function tableDate(start: string, group: Grouping): string {
  return dateOf(start).toLocaleDateString("fr-FR", {
    timeZone: "UTC",
    ...(group === "week"
      ? { day: "2-digit", month: "2-digit", year: "numeric" }
      : { month: "short", year: "numeric" }),
  });
}

const kmNumber = (meters: number) =>
  (Math.round(meters / 100) / 10).toLocaleString("fr-FR");
const km = (meters: number) => `${kmNumber(meters)} km`;
const integer = (value: number) => Math.round(value).toLocaleString("fr-FR");

// Durée courte du récapitulatif : 13 453 s → « 3 h 44 ».
export function formatHoursMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

export type SeriesId =
  "distance" | "elevation" | "pace" | "heartrate" | "longest" | "vdot";

export type Series = {
  id: SeriesId;
  title: string;
  kind: "bar" | "line";
  value: (bucket: ProgressionBucket) => number | null;
  format: (value: number) => string;
  axisFormat: (value: number) => string; // graduations, sans unité
  inverted?: boolean; // allure : en haut = plus rapide
};

export const SERIES: readonly Series[] = [
  {
    id: "distance",
    title: "Volume",
    kind: "bar",
    value: (b) => b.distanceM,
    format: km,
    axisFormat: kmNumber,
  },
  {
    id: "elevation",
    title: "Dénivelé positif",
    kind: "bar",
    value: (b) => b.elevationGainM,
    format: (m) => `${integer(m)} m`,
    axisFormat: integer,
  },
  {
    id: "pace",
    title: "Allure moyenne",
    kind: "line",
    value: (b) => b.paceSPerKm,
    format: formatPace,
    axisFormat: (s) => formatPace(s).replace("/km", ""),
    inverted: true,
  },
  {
    id: "heartrate",
    title: "FC moyenne",
    kind: "line",
    value: (b) => b.heartrate,
    format: formatHeartrate,
    axisFormat: integer,
  },
  {
    id: "longest",
    title: "Sortie la plus longue",
    kind: "bar",
    value: (b) => b.longestM,
    format: km,
    axisFormat: kmNumber,
  },
  {
    id: "vdot",
    title: "Niveau estimé (VDOT)",
    kind: "line",
    value: (b) => b.vdot,
    format: formatVdot,
    axisFormat: (v) => v.toLocaleString("fr-FR"),
  },
];

const TRENDS: Record<Trend, string> = {
  up: "en hausse",
  down: "en baisse",
  flat: "stable",
};
const PACE_TRENDS: Record<Trend, string> = {
  up: "plus lente",
  down: "plus rapide",
  flat: "stable",
};

// Valeurs résumées : sans la période en cours (incomplète, elle fausserait dernière valeur et
// tendance), sauf s'il n'y en a pas d'autre.
export function completePeriods<T>(values: readonly T[]): T[] {
  return values.length > 1 ? values.slice(0, -1) : [...values];
}

// Résumé texte d'un graphique : « Dernière période complète : 32,4 km · moyenne : 28,1 km · tendance : en hausse ».
export function describeSeries(
  series: Series,
  values: (number | null)[],
): string {
  const { last, mean, trend } = summarize(values);
  if (last === null || mean === null) return "Aucune donnée sur la période.";
  const parts = [
    `Dernière période complète : ${series.format(last)}`,
    `moyenne : ${series.format(mean)}`,
  ];
  if (trend !== null) {
    parts.push(`tendance : ${(series.inverted ? PACE_TRENDS : TRENDS)[trend]}`);
  }
  return `${parts.join(" · ")}.`;
}

// Message quand l'historique importé ne couvre pas tout (ADR 0004 : import manuel), sinon null.
export function staleMessage(
  lastImportedRunDate: string | null,
  historyStale: boolean,
): string | null {
  if (!historyStale) return null;
  if (lastImportedRunDate === null) {
    return "Seules tes courses des 7 derniers jours sont connues : importe ton historique Strava pour voir ta progression sur la durée.";
  }
  return `Ton historique importé s'arrête au ${formatDay(lastImportedRunDate, "Europe/Paris")} : les courses suivantes (hors 7 derniers jours) manquent. Réimporte ton fichier activities.csv pour le compléter.`;
}
