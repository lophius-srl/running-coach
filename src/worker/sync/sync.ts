// Synchro des activités Strava récentes (cron quotidien et bouton « Synchroniser maintenant »).
// Ne stocke que les courses des 7 derniers jours ; purge tout ce qui a été récupéré il y a plus de 7 jours.

import type { Bindings } from "../env";
import {
  stravaApiFetch,
  StravaError,
  StravaReauthorizationRequired,
} from "../strava/client";
import { partitionActivities, purgeCutoff, syncWindowStart } from "./rules";
import { deleteActivity, upsertActivity } from "./store";

const PER_PAGE = 100;
// Garde-fou : 7 jours tiennent largement dans une page ; borne le temps CPU et les appels.
const MAX_PAGES = 3;

export type SyncResult = { imported: number };

async function fetchRecentActivities(
  env: Bindings,
  userId: number,
  nowMs: number,
): Promise<unknown[]> {
  const after = syncWindowStart(nowMs);
  const activities: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await stravaApiFetch(
      env.DB,
      env,
      userId,
      `/athlete/activities?after=${after}&per_page=${PER_PAGE}&page=${page}`,
    );
    if (!response.ok) {
      throw new StravaError(`Strava activities: HTTP ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) {
      throw new StravaError("Strava activities: unexpected response");
    }
    activities.push(...body);
    if (body.length < PER_PAGE) break;
  }
  return activities;
}

export async function purgeExpiredActivities(
  db: D1Database,
  nowMs: number,
): Promise<number> {
  const { meta } = await db
    .prepare("DELETE FROM strava_activities WHERE fetched_at < ?")
    .bind(purgeCutoff(nowMs))
    .run();
  return meta.changes;
}

export async function syncUserActivities(
  env: Bindings,
  userId: number,
  nowMs: number,
): Promise<SyncResult> {
  const { runs, otherIds } = partitionActivities(
    await fetchRecentActivities(env, userId, nowMs),
  );
  const fetchedAt = new Date(nowMs).toISOString();
  const db = env.DB;
  const upserts = runs.map((activity) =>
    upsertActivity(db, userId, activity, fetchedAt),
  );
  const deletions = otherIds.map((id) => deleteActivity(db, userId, id));
  if (upserts.length + deletions.length === 0) return { imported: 0 };
  const results = await db.batch([...upserts, ...deletions]);
  // L'upsert gardé par user_id n'écrit rien sur l'activité d'un autre utilisateur.
  const imported = results
    .slice(0, upserts.length)
    .reduce((total, result) => total + result.meta.changes, 0);
  return { imported };
}

// Même synchro pour le cron et le bouton : purge d'abord (indépendante de Strava), puis import.
export async function runSync(
  env: Bindings,
  userId: number,
  nowMs: number,
): Promise<SyncResult> {
  await purgeExpiredActivities(env.DB, nowMs);
  return syncUserActivities(env, userId, nowMs);
}

// Cron quotidien : purge globale, puis synchro de chaque utilisateur connecté (tokens présents).
// Un accès révoqué (401, refresh refusé) supprime tokens et activités sans faire échouer le run.
// L'échec d'un utilisateur n'empêche pas la synchro des autres ; il est relancé à la fin
// pour que l'exécution apparaisse en échec dans l'observabilité Cloudflare.
export async function runDailySync(
  env: Bindings,
  nowMs: number,
): Promise<void> {
  await purgeExpiredActivities(env.DB, nowMs);
  const { results } = await env.DB.prepare(
    "SELECT user_id FROM oauth_tokens",
  ).all<{ user_id: number }>();
  let failure: unknown = null;
  for (const { user_id: userId } of results) {
    try {
      await syncUserActivities(env, userId, nowMs);
    } catch (err) {
      // Accès révoqué : les données sont déjà supprimées, ce n'est pas un échec du cron.
      if (!(err instanceof StravaReauthorizationRequired)) failure ??= err;
    }
  }
  if (failure !== null) throw failure;
}
