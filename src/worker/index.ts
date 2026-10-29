import { Hono } from "hono";

export type Bindings = {
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_WEBHOOK_VERIFY_TOKEN: string;
  SESSION_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
