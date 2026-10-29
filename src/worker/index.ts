import { Hono } from "hono";
import { authRoutes } from "./auth/routes";
import { readSession } from "./auth/session";
import type { AppEnv } from "./env";

export type { Bindings } from "./env";

// Routes /api/* accessibles sans session.
const PUBLIC_API_PREFIXES = ["/api/auth/", "/api/strava/webhook"];

const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/api/*", async (c, next) => {
  if (PUBLIC_API_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) {
    return next();
  }
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
