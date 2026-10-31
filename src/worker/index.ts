import { Hono } from "hono";
import { summarizeRecentRuns } from "./activities/recent";
import { authRoutes } from "./auth/routes";
import { readSession } from "./auth/session";
import { goalRoutes } from "./goals/routes";
import { historyRoutes } from "./history/routes";
import { planRoutes } from "./plans/routes";
import type { AppEnv, Bindings } from "./env";
import { StravaError, StravaReauthorizationRequired } from "./strava/client";
import { runDailySync, runSync } from "./sync/sync";
import { webhookRoutes } from "./webhook/routes";

export type { Bindings } from "./env";

// Routes /api/* accessibles sans session : tout /api/auth/ (OAuth, logout) et le webhook
// Strava, en chemin exact pour ne pas exposer /api/strava/webhook-admin, /api/strava/webhooks…
const PUBLIC_API_PREFIX = "/api/auth/";
const PUBLIC_API_PATHS = ["/api/strava/webhook"];

function isPublicApiPath(path: string): boolean {
  return path.startsWith(PUBLIC_API_PREFIX) || PUBLIC_API_PATHS.includes(path);
}

const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/api/*", async (c, next) => {
  if (isPublicApiPath(c.req.path)) return next();
  const userId = await readSession(c, c.env.SESSION_SECRET);
  if (userId === null) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", userId);
  return next();
});

app.route("/api/auth", authRoutes);
app.route("/api/goal", goalRoutes);
app.route("/api/history", historyRoutes);
app.route("/api/plan", planRoutes);
app.route("/api/strava/webhook", webhookRoutes);

app.get("/api/me", async (c) => {
  const user = await c.env.DB.prepare(
    "SELECT strava_athlete_id FROM users WHERE id = ?",
  )
    .bind(c.get("userId"))
    .first<{ strava_athlete_id: number }>();
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.json({ athleteId: user.strava_athlete_id });
});

// « Synchroniser maintenant » : même synchro que le cron, pour l'utilisateur de la session.
app.post("/api/sync", async (c) => {
  try {
    return c.json(await runSync(c.env, c.get("userId"), Date.now()));
  } catch (err) {
    if (err instanceof StravaReauthorizationRequired) {
      return c.json({ error: "strava_reauthorization_required" }, 401);
    }
    if (err instanceof StravaError) return c.json({ error: "strava" }, 502);
    throw err;
  }
});

// Tableau de bord : courses des 7 derniers jours de l'utilisateur, sans le payload brut.
app.get("/api/activities", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT payload FROM strava_activities WHERE user_id = ? ORDER BY id DESC",
  )
    .bind(c.get("userId"))
    .all<{ payload: string }>();
  return c.json(
    summarizeRecentRuns(
      results.map((row) => row.payload),
      Date.now(),
    ),
  );
});

export { app };

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runDailySync(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Bindings>;
