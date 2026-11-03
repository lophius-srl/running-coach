// Effacement des séances de la montre d'un utilisateur (ADR 0005, « Suppression ») : lignes D1
// (watch_imports, watch_activities) et fichiers FIT bruts dans R2 (fit/<user_id>/).
// À appeler par DELETE /api/history (issue #37, « Supprimer mon historique importé ») et par une
// future suppression de compte : la cascade D1 n'atteint pas R2, qui n'a pas de clé étrangère.
// PAS par la désautorisation Strava : ces données viennent de la montre, pas de l'API (durables).

import type { Bindings } from "../env";

// Plafond de R2Bucket.delete() par appel, et taille de page de list().
export const R2_DELETE_BATCH = 1000;

export function fitPrefix(userId: number): string {
  return `fit/${userId}/`;
}

// D1 d'abord : les séances disparaissent de l'app même si R2 échoue ensuite. Un nouvel appel
// reprend là où il s'est arrêté (la liste R2 est relue depuis le préfixe).
export async function deleteWatchData(
  env: Pick<Bindings, "DB" | "FIT_BUCKET">,
  userId: number,
  pageSize = R2_DELETE_BATCH,
): Promise<void> {
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM watch_imports WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM watch_activities WHERE user_id = ?").bind(userId),
  ]);
  const limit = Math.min(pageSize, R2_DELETE_BATCH);
  let cursor: string | undefined;
  do {
    const page = await env.FIT_BUCKET.list({
      prefix: fitPrefix(userId),
      limit,
      cursor,
    });
    if (page.objects.length > 0) {
      await env.FIT_BUCKET.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}
