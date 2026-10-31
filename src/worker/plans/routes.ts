// Plan de la semaine (issue #15) : généré par src/core/plan (déterministe), stocké dans les
// tables durables plans / plan_sessions (« plans générés », ADR 0003), sans les allures cibles.

import { Hono } from "hono";
import type { AppEnv } from "../env";
import type { TrainingPaces } from "../../core/paces";
import { trainingPaces } from "../../core/paces";
import {
  generateWeekPlan,
  type PlanPhase,
  type SessionKind,
  type WeekPlan,
} from "../../core/plan";
import { loadFitness } from "../goals/fitness";
import { toGoal, type GoalRow } from "../goals/routes";
import { APP_TIME_ZONE, localIsoDate, type Goal } from "../goals/rules";
import { withTargetPaces, type PlanError } from "./view";

type PlanRow = {
  week_start: string;
  phase: PlanPhase;
  scheduled_date: string | null; // null : plan sans séance (course imminente)
  kind: SessionKind | null;
  duration_min: number | null;
  description: string | null;
};

const SELECT_GOAL = `
  SELECT id, distance_m, race_date, target_time_s, available_days FROM goals WHERE user_id = ?`;

// Dernier plan de l'objectif de l'utilisateur (les plans antérieurs à #15 n'ont pas de week_start).
const LATEST_PLAN = `
  SELECT p.week_start, p.phase, s.scheduled_date, s.kind, s.duration_min, s.description
  FROM plans p LEFT JOIN plan_sessions s ON s.plan_id = p.id
  WHERE p.id = (
    SELECT max(p2.id) FROM plans p2 JOIN goals g ON g.id = p2.goal_id
    WHERE g.user_id = ? AND p2.week_start IS NOT NULL
  )
  ORDER BY s.scheduled_date`;

const INSERT_PLAN =
  "INSERT INTO plans (goal_id, week_start, phase) VALUES (?, ?, ?)";

// Même transaction (db.batch) que INSERT_PLAN : max(id) est le plan qui vient d'être créé.
// Toutes les séances passent en un seul paramètre JSON (limite D1 de 100 paramètres).
const INSERT_SESSIONS = `
  INSERT INTO plan_sessions (plan_id, scheduled_date, kind, duration_min, description)
  SELECT (SELECT max(id) FROM plans WHERE goal_id = ?), json_extract(value, '$.date'),
    json_extract(value, '$.kind'), json_extract(value, '$.durationMin'),
    json_extract(value, '$.description')
  FROM json_each(?)`;

function toPlan(rows: PlanRow[]): WeekPlan | null {
  if (rows.length === 0) return null;
  const sessions = rows.flatMap(
    ({ scheduled_date, kind, duration_min, description }) =>
      scheduled_date && kind && duration_min
        ? [
            {
              date: scheduled_date,
              kind,
              durationMin: duration_min,
              description: description ?? "",
            },
          ]
        : [],
  );
  return { weekStart: rows[0].week_start, phase: rows[0].phase, sessions };
}

async function loadGoalAndPaces(db: D1Database, userId: number, nowMs: number) {
  const [row, fitness] = await Promise.all([
    db.prepare(SELECT_GOAL).bind(userId).first<GoalRow & { id: number }>(),
    loadFitness(db, userId, nowMs),
  ]);
  const goal: Goal | null = row && toGoal(row);
  const paces: TrainingPaces | null =
    goal && fitness && trainingPaces({ ...goal, vdot: fitness.vdot });
  return { goalId: row?.id ?? null, goal, paces };
}

export const planRoutes = new Hono<AppEnv>();

planRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const [{ paces }, { results }] = await Promise.all([
    loadGoalAndPaces(c.env.DB, userId, Date.now()),
    c.env.DB.prepare(LATEST_PLAN).bind(userId).all<PlanRow>(),
  ]);
  const plan = toPlan(results);
  return c.json({ plan: plan && withTargetPaces(plan, paces) });
});

planRoutes.post("/", async (c) => {
  const nowMs = Date.now();
  const db = c.env.DB;
  const { goalId, goal, paces } = await loadGoalAndPaces(
    db,
    c.get("userId"),
    nowMs,
  );
  const refuse = (error: PlanError) => c.json({ error }, 409);
  if (goalId === null || goal === null) return refuse("no_goal");
  if (paces === null) return refuse("no_paces");
  const plan = generateWeekPlan({
    ...goal,
    today: localIsoDate(nowMs, APP_TIME_ZONE),
  });
  if (plan === null) return refuse("race_passed");

  await db.batch([
    db.prepare(INSERT_PLAN).bind(goalId, plan.weekStart, plan.phase),
    db.prepare(INSERT_SESSIONS).bind(goalId, JSON.stringify(plan.sessions)),
  ]);
  return c.json({ plan: withTargetPaces(plan, paces) });
});
