// Règles pures de la synchro Strava (sans I/O). Voir docs/adr/0003 : données Strava ≤ 7 jours.

import { RUN_TYPES } from "../../core/run-types";

export const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type StravaActivity = {
  id: number;
  type?: unknown;
  sport_type?: unknown;
};

// sport_type (plus précis) fait foi ; type sert de repli pour les anciennes activités.
export function isRun(activity: StravaActivity): boolean {
  const kind =
    typeof activity.sport_type === "string"
      ? activity.sport_type
      : activity.type;
  return typeof kind === "string" && RUN_TYPES.has(kind);
}

// Paramètre `after` de l'API Strava (epoch en secondes) : début de la fenêtre de 7 jours.
export function syncWindowStart(nowMs: number): number {
  return Math.floor((nowMs - RETENTION_MS) / 1000);
}

// Toute activité dont fetched_at est strictement antérieur à ce seuil doit être supprimée.
// Même format que fetched_at (Date.toISOString) : la comparaison de chaînes est chronologique.
export function purgeCutoff(nowMs: number): string {
  return new Date(nowMs - RETENTION_MS).toISOString();
}

function isActivity(value: unknown): value is StravaActivity {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as { id?: unknown }).id)
  );
}

// Sépare les courses à conserver des autres activités (dont on supprime une éventuelle
// copie, ex. une course requalifiée en vélo). Dédoublonne par id : la dernière occurrence gagne.
export function partitionActivities(items: unknown[]): {
  runs: StravaActivity[];
  otherIds: number[];
} {
  const byId = new Map<number, StravaActivity>();
  for (const item of items) {
    if (isActivity(item)) byId.set(item.id, item);
  }
  const runs: StravaActivity[] = [];
  const otherIds: number[] = [];
  for (const activity of byId.values()) {
    if (isRun(activity)) runs.push(activity);
    else otherIds.push(activity.id);
  }
  return { runs, otherIds };
}
