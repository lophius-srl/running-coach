export type Bindings = {
  DB: D1Database;
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_WEBHOOK_VERIFY_TOKEN: string;
  SESSION_SECRET: string;
  // Id d'athlète Strava du propriétaire (wrangler.json › vars). Absent ou vide : connexion refusée.
  OWNER_ATHLETE_ID?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: { userId: number };
};
