import { Hono } from "hono";
import { authRoutes } from "./auth/routes";
import { readSession } from "./auth/session";
import type { AppEnv } from "./env";

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

app.get("/api/me", async (c) => {
  const user = await c.env.DB.prepare(
    "SELECT strava_athlete_id FROM users WHERE id = ?",
  )
    .bind(c.get("userId"))
    .first<{ strava_athlete_id: number }>();
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.json({ athleteId: user.strava_athlete_id });
});

export default app;
