// Traitement différé (waitUntil) des événements du webhook Strava. Les événements n'étant pas
// signés, chaque action est confirmée auprès de l'API Strava avant d'écrire en base.

import type { Bindings } from "../env";
import {
  stravaApiFetch,
  StravaError,
  StravaReauthorizationRequired,
} from "../strava/client";
import { deleteStravaData } from "../strava/revocation";
import { deleteActivity, upsertActivity } from "../sync/store";
import { decideActivity, type WebhookAction } from "./rules";

async function findUserId(
  db: D1Database,
  athleteId: number,
): Promise<number | null> {
  const user = await db
    .prepare("SELECT id FROM users WHERE strava_athlete_id = ?")
    .bind(athleteId)
    .first<{ id: number }>();
  return user?.id ?? null;
}

// Corps de GET /activities/{id}, ou null si Strava ne la connaît pas (supprimée, inaccessible).
async function fetchActivity(
  env: Bindings,
  userId: number,
  activityId: number,
): Promise<unknown> {
  const response = await stravaApiFetch(
    env.DB,
    env,
    userId,
    `/activities/${activityId}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new StravaError(`Strava activity: HTTP ${response.status}`);
  }
  return response.json().catch(() => {
    throw new StravaError("Strava activity: invalid JSON");
  });
}

async function syncActivity(
  env: Bindings,
  userId: number,
  athleteId: number,
  activityId: number,
  payload: unknown,
  nowMs: number,
): Promise<void> {
  // null : Strava ne sert plus l'activité (404), on retire la copie locale.
  const decision =
    payload === null
      ? { kind: "remove" as const }
      : decideActivity(payload, activityId, athleteId, nowMs);
  if (decision.kind === "invalid") {
    throw new StravaError("Strava activity: unexpected response");
  }
  const statement =
    decision.kind === "store"
      ? upsertActivity(
          env.DB,
          userId,
          decision.activity,
          new Date(nowMs).toISOString(),
        )
      : deleteActivity(env.DB, userId, activityId);
  await statement.run();
}

async function applyWebhookAction(
  env: Bindings,
  action: WebhookAction,
  nowMs: number,
): Promise<void> {
  if (action.kind === "ignore") return;
  const userId = await findUserId(env.DB, action.athleteId);
  if (userId === null) return;
  switch (action.kind) {
    case "deauthorize":
      // Sans confirmation auprès de Strava : la suppression prime (§6.3).
      return deleteStravaData(env.DB, userId);
    case "refresh-activity": {
      const payload = await fetchActivity(env, userId, action.activityId);
      // await plutôt que return : évite une « unhandled rejection » si syncActivity rejette d'emblée.
      await syncActivity(
        env,
        userId,
        action.athleteId,
        action.activityId,
        payload,
        nowMs,
      );
      return;
    }
    case "remove-activity": {
      // Encore visible chez Strava comme course à garder = faux événement : on n'y touche pas.
      // En cas d'erreur de l'API, on supprime quand même (la suppression prime).
      const payload = await fetchActivity(env, userId, action.activityId).catch(
        () => null,
      );
      const decision = decideActivity(
        payload,
        action.activityId,
        action.athleteId,
        nowMs,
      );
      if (decision.kind === "store") return;
      await deleteActivity(env.DB, userId, action.activityId).run();
    }
  }
}

// Accès révoqué pendant le traitement : tokens et activités sont déjà supprimés, rien à signaler.
export async function processWebhookAction(
  env: Bindings,
  action: WebhookAction,
  nowMs: number,
): Promise<void> {
  try {
    await applyWebhookAction(env, action, nowMs);
  } catch (err) {
    if (!(err instanceof StravaReauthorizationRequired)) throw err;
  }
}
