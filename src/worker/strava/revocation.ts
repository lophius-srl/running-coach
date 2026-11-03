// Accès Strava révoqué (ADR 0003 §6.3) : tokens OAuth et activités API supprimés immédiatement.
// Objectif, plans et historique importé (données de l'utilisateur, ADR 0004) sont conservés.
// Les séances de la montre (watch_*, FIT dans R2) aussi : elles viennent de la montre, pas de l'API
// Strava, et sont durables (ADR 0005). Ne pas appeler deleteWatchData ici (src/worker/imports).
export async function deleteStravaData(
  db: D1Database,
  userId: number,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM strava_activities WHERE user_id = ?").bind(userId),
  ]);
}
