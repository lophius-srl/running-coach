// Zones cardiaques (issue #57) : GET / PUT /api/heart-rate-zones. Données saisies par
// l'utilisateur, stockées durablement dans heart_rate_zones (ADR 0003) ; la validation est
// celle du formulaire (src/core/heart-rate.ts), seule celle du serveur fait foi.

import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
  validateHeartRate,
  type HeartRateResponse,
  type HeartRateSettings,
} from "../../core/heart-rate";

type HeartRateRow = { resting_hr: number; max_hr: number; zones: string };

const UPSERT = `
  INSERT INTO heart_rate_zones (user_id, resting_hr, max_hr, zones) VALUES (?, ?, ?, ?)
  ON CONFLICT (user_id) DO UPDATE SET
    resting_hr = excluded.resting_hr,
    max_hr = excluded.max_hr,
    zones = excluded.zones,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

// Zones enregistrées de l'utilisateur, ou null (aussi lu par le plan pour la zone cible).
export async function loadHeartRate(
  db: D1Database,
  userId: number,
): Promise<HeartRateSettings | null> {
  const row = await db
    .prepare(
      "SELECT resting_hr, max_hr, zones FROM heart_rate_zones WHERE user_id = ?",
    )
    .bind(userId)
    .first<HeartRateRow>();
  if (!row) return null;
  const result = validateHeartRate({
    restingHr: row.resting_hr,
    maxHr: row.max_hr,
    zones: JSON.parse(row.zones) as unknown,
  });
  return result.ok ? result.settings : null;
}

export const heartRateRoutes = new Hono<AppEnv>();

heartRateRoutes.get("/", async (c) => {
  const heartRate = await loadHeartRate(c.env.DB, c.get("userId"));
  return c.json<HeartRateResponse>({ heartRate });
});

heartRateRoutes.put("/", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const result = validateHeartRate(body);
  if (!result.ok) return c.json({ errors: result.errors }, 400);
  const { restingHr, maxHr, zones } = result.settings;
  await c.env.DB.prepare(UPSERT)
    .bind(c.get("userId"), restingHr, maxHr, JSON.stringify(zones))
    .run();
  return c.json<HeartRateResponse>({ heartRate: result.settings });
});
