// Webhook Strava (ADR 0003) : validation d'abonnement (GET) et réception d'événements (POST).
// Public (hors session) : Strava n'envoie ni cookie ni signature.

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ownerAthleteId, parseConfiguredId } from "../owner";
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

// Lecture en flux avec un compteur d'octets : on abandonne dès que MAX_BODY_BYTES est dépassé,
// même sans Content-Length (envoi chunked). null si trop gros.
async function readBodyBytes(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) return null;
  try {
    const bytes = await readBodyBytes(request);
    return bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes));
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
    parseConfiguredId(c.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID),
  );
  if (action.kind !== "ignore") {
    c.executionCtx.waitUntil(processWebhookAction(c.env, action, Date.now()));
  }
  return c.body(null, 200);
});
