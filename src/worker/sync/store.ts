// Écritures dans strava_activities, partagées par la synchro et le webhook. Toujours bornées
// à user_id : on n'écrase ni ne supprime jamais l'activité d'un autre utilisateur.

import type { StravaActivity } from "./rules";

export function upsertActivity(
  db: D1Database,
  userId: number,
  activity: StravaActivity,
  fetchedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
         WHERE strava_activities.user_id = excluded.user_id`,
    )
    .bind(activity.id, userId, JSON.stringify(activity), fetchedAt);
}

export function deleteActivity(
  db: D1Database,
  userId: number,
  activityId: number,
): D1PreparedStatement {
  return db
    .prepare("DELETE FROM strava_activities WHERE id = ? AND user_id = ?")
    .bind(activityId, userId);
}
