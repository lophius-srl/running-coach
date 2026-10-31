import { Hono } from "hono";
import type { AppEnv } from "../env";
import type { Fitness } from "../../core/fitness";
import { trainingPaces } from "../../core/paces";
import { loadFitness } from "./fitness";
import {
  APP_TIME_ZONE,
  localIsoDate,
  validateGoal,
  type Goal,
  type GoalResponse,
} from "./rules";

// Les colonnes reference_distance_m / reference_time_s restent en base (migrations additives,
// ADR 0002) mais ne sont plus lues ni écrites depuis #46.
export type GoalRow = {
  distance_m: number;
  race_date: string;
  target_time_s: number | null;
  available_days: string;
};

export function toGoal(row: GoalRow): Goal {
  const days: unknown = JSON.parse(row.available_days);
  return {
    distanceM: row.distance_m,
    raceDate: row.race_date,
    targetTimeS: row.target_time_s,
    availableDays: Array.isArray(days) ? days : [],
  };
}

// Allures calculées à la volée depuis le niveau estimé (ADR 0003 : rien n'est stocké).
function goalResponse(
  goal: Goal | null,
  fitness: Fitness | null,
): GoalResponse {
  if (fitness === null) return { goal, paces: null, basis: null };
  const { startDate, distanceM, movingTimeS } = fitness.run;
  return {
    goal,
    paces: goal && trainingPaces({ ...goal, vdot: fitness.vdot }),
    basis: { startDate, distanceM, movingTimeS },
  };
}

// Un seul objectif par utilisateur (index unique goals.user_id) : l'upsert met à jour la ligne
// existante et garde son id, sans supprimer en cascade les plans qui la référencent.
const UPSERT_GOAL = `
  INSERT INTO goals (user_id, race_date, distance_m, target_time_s, available_days)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (user_id) DO UPDATE SET
    race_date = excluded.race_date,
    distance_m = excluded.distance_m,
    target_time_s = excluded.target_time_s,
    available_days = excluded.available_days,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export const goalRoutes = new Hono<AppEnv>();

goalRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const [row, fitness] = await Promise.all([
    c.env.DB.prepare(
      "SELECT distance_m, race_date, target_time_s, available_days FROM goals WHERE user_id = ?",
    )
      .bind(userId)
      .first<GoalRow>(),
    loadFitness(c.env.DB, userId, Date.now()),
  ]);
  return c.json(goalResponse(row ? toGoal(row) : null, fitness));
});

goalRoutes.put("/", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const nowMs = Date.now();
  const result = validateGoal(body, localIsoDate(nowMs, APP_TIME_ZONE));
  if (!result.ok) return c.json({ errors: result.errors }, 400);

  const { goal } = result;
  const userId = c.get("userId");
  await c.env.DB.prepare(UPSERT_GOAL)
    .bind(
      userId,
      goal.raceDate,
      goal.distanceM,
      goal.targetTimeS,
      JSON.stringify(goal.availableDays),
    )
    .run();
  return c.json(goalResponse(goal, await loadFitness(c.env.DB, userId, nowMs)));
});
