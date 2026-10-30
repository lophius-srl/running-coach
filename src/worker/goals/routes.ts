import { Hono } from "hono";
import type { AppEnv } from "../env";
import { utcIsoDate, validateGoal, type Goal } from "./rules";

type GoalRow = {
  distance_m: number;
  race_date: string;
  target_time_s: number | null;
  reference_distance_m: number | null;
  reference_time_s: number | null;
  available_days: string;
};

// Objectif enregistré : le chrono de référence peut manquer sur une ligne antérieure à #13.
export type SavedGoal = Omit<Goal, "referenceDistanceM" | "referenceTimeS"> & {
  referenceDistanceM: number | null;
  referenceTimeS: number | null;
};

function toSavedGoal(row: GoalRow): SavedGoal {
  const days: unknown = JSON.parse(row.available_days);
  return {
    distanceM: row.distance_m,
    raceDate: row.race_date,
    targetTimeS: row.target_time_s,
    referenceDistanceM: row.reference_distance_m,
    referenceTimeS: row.reference_time_s,
    availableDays: Array.isArray(days) ? days : [],
  };
}

// Un seul objectif par utilisateur (index unique goals.user_id) : l'upsert met à jour la ligne
// existante et garde son id, sans supprimer en cascade les plans qui la référencent.
const UPSERT_GOAL = `
  INSERT INTO goals (user_id, race_date, distance_m, target_time_s,
    reference_distance_m, reference_time_s, available_days)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id) DO UPDATE SET
    race_date = excluded.race_date,
    distance_m = excluded.distance_m,
    target_time_s = excluded.target_time_s,
    reference_distance_m = excluded.reference_distance_m,
    reference_time_s = excluded.reference_time_s,
    available_days = excluded.available_days,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export const goalRoutes = new Hono<AppEnv>();

goalRoutes.get("/", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT distance_m, race_date, target_time_s, reference_distance_m, reference_time_s, available_days FROM goals WHERE user_id = ?",
  )
    .bind(c.get("userId"))
    .first<GoalRow>();
  return c.json({ goal: row ? toSavedGoal(row) : null });
});

goalRoutes.put("/", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const result = validateGoal(body, utcIsoDate(Date.now()));
  if (!result.ok) return c.json({ errors: result.errors }, 400);

  const { goal } = result;
  await c.env.DB.prepare(UPSERT_GOAL)
    .bind(
      c.get("userId"),
      goal.raceDate,
      goal.distanceM,
      goal.targetTimeS,
      goal.referenceDistanceM,
      goal.referenceTimeS,
      JSON.stringify(goal.availableDays),
    )
    .run();
  return c.json({ goal });
});
