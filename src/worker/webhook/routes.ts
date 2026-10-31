// Webhook Strava (ADR 0003) : validation d'abonnement (GET) et réception d'événements (POST).
// Public (hors session) : Strava n'envoie ni cookie ni signature.

import { Hono } from "hono";
import { ownerAthleteId } from "../auth/routes";
import type { AppEnv } from "../env";
import { processWebhookAction } from "./process";
import {
  checkSubscriptionRequest,
  decideWebhookAction,
  parseWebhookEvent,
} from "./rules";

// Un événement Strava fait quelques centaines d'octets : au-delà, le corps est ignoré.
const MAX_BODY_BYTES = 4096;

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

// Comparaison à temps constant (empreintes de même longueur) ; fail closed sans token configuré.
async function matchesVerifyToken(
  received: string | undefined,
  expected: string | undefined,
): Promise<boolean> {
  if (!expected || received === undefined) return false;
  const [a, b] = await Promise.all([sha256(received), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const webhookRoutes = new Hono<AppEnv>();

webhookRoutes.get("/", async (c) => {
  const tokenMatches = await matchesVerifyToken(
    c.req.query("hub.verify_token"),
    c.env.STRAVA_WEBHOOK_VERIFY_TOKEN,
  );
  const check = checkSubscriptionRequest(
    c.req.query("hub.mode"),
    c.req.query("hub.challenge"),
    tokenMatches,
  );
  if (check.kind === "forbidden") return c.json({ error: "forbidden" }, 403);
  if (check.kind === "invalid") return c.json({ error: "invalid" }, 400);
  return c.json({ "hub.challenge": check.challenge });
});

// Accusé de réception immédiat (Strava exige 200 en moins de 2 s), traitement après la réponse.
webhookRoutes.post("/", async (c) => {
  const action = decideWebhookAction(
    parseWebhookEvent(await readJsonBody(c.req.raw)),
    ownerAthleteId(c.env.OWNER_ATHLETE_ID),
  );
  if (action.kind !== "ignore") {
    c.executionCtx.waitUntil(processWebhookAction(c.env, action, Date.now()));
  }
  return c.body(null, 200);
});
