// Règles pures du webhook Strava (sans I/O). Strava ne signe pas ses événements : tout corps
// inattendu est ignoré, et aucune entrée non validée n'est renvoyée ni journalisée.

import { isRun, RETENTION_DAYS, type StravaActivity } from "../sync/rules";

const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
// Le challenge Strava est une chaîne aléatoire courte : on ne renvoie que ce format.
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

const OBJECT_TYPES = ["activity", "athlete"] as const;
const ASPECT_TYPES = ["create", "update", "delete"] as const;

export type WebhookEvent = {
  objectType: (typeof OBJECT_TYPES)[number];
  aspectType: (typeof ASPECT_TYPES)[number];
  objectId: number;
  ownerId: number;
  deauthorized: boolean;
};

export type WebhookAction =
  | { kind: "ignore" }
  | { kind: "deauthorize"; athleteId: number }
  | { kind: "refresh-activity"; athleteId: number; activityId: number }
  | { kind: "remove-activity"; athleteId: number; activityId: number };

export type SubscriptionCheck =
  | { kind: "ok"; challenge: string }
  | { kind: "forbidden" }
  | { kind: "invalid" };

function isPositiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return values.includes(value as T);
}

export function parseWebhookEvent(body: unknown): WebhookEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const event = body as Record<string, unknown>;
  const { object_type, aspect_type, object_id, owner_id } = event;
  if (!oneOf(OBJECT_TYPES, object_type) || !oneOf(ASPECT_TYPES, aspect_type)) {
    return null;
  }
  if (!isPositiveId(object_id) || !isPositiveId(owner_id)) return null;
  const updates = event.updates;
  const authorized =
    typeof updates === "object" && updates !== null
      ? (updates as { authorized?: unknown }).authorized
      : undefined;
  return {
    objectType: object_type,
    aspectType: aspect_type,
    objectId: object_id,
    ownerId: owner_id,
    // Strava envoie la chaîne "false" ; le booléen est accepté par prudence.
    deauthorized: authorized === "false" || authorized === false,
  };
}

// Seuls les événements du propriétaire sont traités ; sans propriétaire configuré, rien ne l'est.
export function decideWebhookAction(
  event: WebhookEvent | null,
  ownerAthleteId: number | null,
): WebhookAction {
  if (event === null || ownerAthleteId === null) return { kind: "ignore" };
  if (event.ownerId !== ownerAthleteId) return { kind: "ignore" };
  const athleteId = ownerAthleteId;
  if (event.objectType === "athlete") {
    return event.deauthorized
      ? { kind: "deauthorize", athleteId }
      : { kind: "ignore" };
  }
  const activityId = event.objectId;
  return event.aspectType === "delete"
    ? { kind: "remove-activity", athleteId, activityId }
    : { kind: "refresh-activity", athleteId, activityId };
}

// Validation d'abonnement (GET hub.*) ; tokenMatches est calculé à temps constant par l'appelant.
export function checkSubscriptionRequest(
  mode: string | undefined,
  challenge: string | undefined,
  tokenMatches: boolean,
): SubscriptionCheck {
  if (!tokenMatches) return { kind: "forbidden" };
  if (
    mode !== "subscribe" ||
    !challenge ||
    !CHALLENGE_PATTERN.test(challenge)
  ) {
    return { kind: "invalid" };
  }
  return { kind: "ok", challenge };
}

// Activité renvoyée par GET /activities/{id} : on la garde si c'est une course du propriétaire
// commencée dans la fenêtre de 7 jours ; sinon on retire une éventuelle copie.
// "invalid" : réponse inattendue de Strava (on ne touche à rien).
export function decideActivity(
  payload: unknown,
  activityId: number,
  ownerAthleteId: number,
  nowMs: number,
):
  { kind: "store"; activity: StravaActivity } | { kind: "remove" | "invalid" } {
  if (typeof payload !== "object" || payload === null) {
    return { kind: "invalid" };
  }
  const activity = payload as StravaActivity & {
    athlete?: { id?: unknown };
    start_date?: unknown;
  };
  if (activity.id !== activityId) return { kind: "invalid" };
  const startMs =
    typeof activity.start_date === "string"
      ? Date.parse(activity.start_date)
      : Number.NaN;
  const keep =
    activity.athlete?.id === ownerAthleteId &&
    isRun(activity) &&
    startMs >= nowMs - RETENTION_MS;
  return keep ? { kind: "store", activity } : { kind: "remove" };
}
